// Interactive SVG map: draws Natural Earth countries with D3, supports pinch
// zoom and pan, and gives tiny countries a tappable dot.
import { geoArea, geoCentroid, geoMercator, geoNaturalEarth1, geoPath, type GeoProjection } from 'd3-geo';
import { select, type Selection } from 'd3-selection';
import 'd3-transition';
import { zoom, zoomIdentity, type ZoomBehavior } from 'd3-zoom';
import type { Feature, FeatureCollection, Geometry, MultiPolygon, Polygon } from 'geojson';
import { feature } from 'topojson-client';
import type { Topology } from 'topojson-specification';
import topo from 'world-atlas/countries-50m.json';
import { COUNTRIES, COUNTRY_BY_ID, REGIONS, SHAPE_TO_COUNTRY, type RegionId } from './countries';

type Shape = Feature<Geometry, { name: string }>;

const ALL_SHAPES: Shape[] = (
  feature(topo as unknown as Topology, (topo as any).objects.countries) as unknown as FeatureCollection<Geometry, { name: string }>
).features.filter((f) => f.properties.name !== 'Antarctica');

const SVG_NS = 'http://www.w3.org/2000/svg';
const DOT_RADIUS = 6; // screen px
const TINY_AREA = 40; // px² at normal zoom, below which a country also gets a dot
const DOT_HIDE_AREA = 400; // px² on screen; once zoomed in this far, the dot is hidden

/** Center of a country's largest polygon (so island groups don't land in the sea between them). */
function mainCentroid(f: Shape): [number, number] {
  const g = f.geometry;
  if (g.type === 'MultiPolygon') {
    let best: Polygon | undefined;
    let bestArea = -1;
    for (const coords of (g as MultiPolygon).coordinates) {
      const p: Polygon = { type: 'Polygon', coordinates: coords };
      const a = geoArea(p);
      if (a > bestArea) [best, bestArea] = [p, a];
    }
    return geoCentroid(best!);
  }
  return geoCentroid(f);
}

export interface MapOptions {
  region: RegionId | 'world';
  /** Countries that respond to taps. */
  interactive: Set<string>;
  onTap?: (countryId: string) => void;
}

export class WorldMap {
  readonly el: HTMLDivElement;
  private svg!: Selection<SVGSVGElement, unknown, null, undefined>;
  private layer!: Selection<SVGGElement, unknown, null, undefined>;
  private zoomer!: ZoomBehavior<SVGSVGElement, unknown>;
  private projection!: GeoProjection;
  private width = 0;
  private height = 0;
  private k = 1;
  private nodes = new Map<string, SVGElement[]>(); // country id -> its paths + dot
  private classes = new Map<string, string>();
  private resizeObs: ResizeObserver;
  private resizeTimer = 0;
  private labels: [id: string, text: string, cls: string][] = [];
  private focused: string | null = null;

  constructor(private opts: MapOptions) {
    this.el = document.createElement('div');
    this.el.className = 'map';
    this.resizeObs = new ResizeObserver(() => {
      const { clientWidth: w, clientHeight: h } = this.el;
      if (w && h && (Math.abs(w - this.width) > 2 || Math.abs(h - this.height) > 2)) {
        clearTimeout(this.resizeTimer);
        this.resizeTimer = window.setTimeout(() => this.render(), 120);
      }
    });
    this.resizeObs.observe(this.el);
  }

  destroy() {
    this.resizeObs.disconnect();
    clearTimeout(this.resizeTimer);
    this.svg?.interrupt();
    this.el.remove();
  }

  private makeProjection(): GeoProjection {
    const pad = 8;
    const extent: [[number, number], [number, number]] = [[pad, pad], [this.width - pad, this.height - pad]];
    if (this.opts.region === 'world') {
      return geoNaturalEarth1().rotate([-10, 0]).fitExtent(extent, { type: 'Sphere' });
    }
    const [w, s, e, n] = REGIONS.find((r) => r.id === this.opts.region)!.bbox;
    const midLon = (w + e) / 2;
    const pts: [number, number][] = [];
    for (let i = 0; i <= 4; i++) {
      const lon = w + ((e - w) * i) / 4;
      pts.push([lon, s], [lon, n]);
    }
    return geoMercator().rotate([-midLon, 0]).fitExtent(extent, { type: 'MultiPoint', coordinates: pts });
  }

  render() {
    this.width = this.el.clientWidth;
    this.height = this.el.clientHeight;
    if (!this.width || !this.height) return;
    this.svg?.interrupt();
    this.el.replaceChildren();
    this.nodes.clear();
    this.projection = this.makeProjection();
    const path = geoPath(this.projection);

    this.svg = select(this.el)
      .append('svg')
      .attr('width', this.width)
      .attr('height', this.height)
      .attr('viewBox', `0 0 ${this.width} ${this.height}`);
    const layer = (this.layer = this.svg.append('g'));
    const shapesG = this.layer.append('g').attr('class', 'shapes');
    const dotsG = this.layer.append('g').attr('class', 'dots');
    this.layer.append('g').attr('class', 'labels');

    const tinyIds = new Set<string>();
    const shapeArea = new Map<string, number>();
    const centroids = new Map<string, [number, number]>();

    for (const f of ALL_SHAPES) {
      const d = path(f);
      if (!d) continue;
      const id = SHAPE_TO_COUNTRY.get(f.properties.name);
      const el = document.createElementNS(SVG_NS, 'path');
      el.setAttribute('d', d);
      if (id) {
        el.setAttribute('class', 'country');
        el.dataset.id = id;
        this.track(id, el);
        const country = COUNTRY_BY_ID.get(id)!;
        // Only the country's main shape decides whether it is "tiny".
        if (f.properties.name === country.shapes[0]) {
          shapeArea.set(id, path.area(f));
          centroids.set(id, mainCentroid(f));
        }
      } else {
        el.setAttribute('class', 'land'); // territories, disputed areas etc.
      }
      shapesG.node()!.appendChild(el);
    }

    for (const c of COUNTRIES) {
      if (c.point) centroids.set(c.id, c.point);
      if (c.point || (shapeArea.get(c.id) ?? 0) < TINY_AREA) tinyIds.add(c.id);
    }
    for (const id of tinyIds) {
      // Dots only for this region's countries; neighbors don't need tap targets.
      if (this.opts.region !== 'world' && COUNTRY_BY_ID.get(id)!.region !== this.opts.region) continue;
      const xy = this.projection(centroids.get(id)!);
      if (!xy) continue;
      const dot = document.createElementNS(SVG_NS, 'circle');
      dot.setAttribute('cx', String(xy[0]));
      dot.setAttribute('cy', String(xy[1]));
      dot.setAttribute('r', String(this.dotRadius));
      dot.setAttribute('class', 'country dot');
      dot.dataset.area = String(shapeArea.get(id) ?? 0);
      dot.dataset.id = id;
      this.track(id, dot);
      dotsG.node()!.appendChild(dot);
    }

    for (const [id, els] of this.nodes) {
      const on = this.opts.region === 'world' || COUNTRY_BY_ID.get(id)!.region === this.opts.region;
      for (const el of els) {
        el.classList.toggle('active', on);
        el.classList.toggle('inactive', !on);
      }
      const cls = this.classes.get(id);
      if (cls) for (const el of els) el.classList.add(cls);
    }

    this.layer.on('click', (ev: MouseEvent) => {
      const t = ev.target as SVGElement;
      const id = t.dataset?.id;
      if (id && this.opts.interactive.has(id)) this.opts.onTap?.(id);
    });

    this.zoomer = zoom<SVGSVGElement, unknown>()
      .scaleExtent([1, 60])
      .translateExtent([[-this.width * 0.25, -this.height * 0.25], [this.width * 1.25, this.height * 1.25]])
      .on('zoom', (ev) => {
        // Uses this render's own nodes, so a transition left over from an
        // earlier render can't touch the current map.
        if (layer !== this.layer) return;
        layer.attr('transform', ev.transform.toString());
        this.k = ev.transform.k;
        const k = this.k;
        dotsG
          .selectAll<SVGCircleElement, unknown>('circle')
          .attr('r', this.dotRadius / k)
          // A dot is only a tap target for countries too small to tap; hide it once
          // you've zoomed in far enough to tap the country itself.
          .attr('display', function () {
            return Number(this.dataset.area) * k * k >= DOT_HIDE_AREA ? 'none' : null;
          });
        layer.selectAll<SVGTextElement, unknown>('.labels text').attr('font-size', 15 / this.k);
      });
    this.svg.call(this.zoomer).on('dblclick.zoom', null);
    this.k = 1;
    for (const [id, text, cls] of this.labels) this.drawLabel(id, text, cls);
    if (this.focused) this.focus(this.focused);
  }

  private get dotRadius() {
    return this.opts.region === 'world' ? DOT_RADIUS * 0.6 : DOT_RADIUS;
  }

  private track(id: string, el: SVGElement) {
    const list = this.nodes.get(id);
    if (list) list.push(el);
    else this.nodes.set(id, [el]);
  }

  /** Set a status class on a country (e.g. 'correct', 'wrong', 'target'); null clears. */
  mark(id: string, cls: string | null) {
    const prev = this.classes.get(id);
    for (const el of this.nodes.get(id) ?? []) {
      if (prev) el.classList.remove(prev);
      if (cls) el.classList.add(cls);
    }
    if (cls) this.classes.set(id, cls);
    else this.classes.delete(id);
  }

  clearMarks() {
    for (const id of [...this.classes.keys()]) this.mark(id, null);
  }

  /** Put a floating name label on a country. */
  label(id: string, text: string, cls = '') {
    this.labels.push([id, text, cls]);
    this.drawLabel(id, text, cls);
  }

  private drawLabel(id: string, text: string, cls: string) {
    const c = COUNTRY_BY_ID.get(id)!;
    const shape = ALL_SHAPES.find((f) => f.properties.name === c.shapes[0]);
    const xy = this.projection(c.point ?? (shape ? mainCentroid(shape) : [0, 0]));
    if (!xy) return;
    this.layer
      .select('.labels')
      .append('text')
      .attr('x', xy[0])
      .attr('y', xy[1] - 10 / this.k)
      .attr('text-anchor', 'middle')
      .attr('font-size', 15 / this.k)
      .attr('class', cls)
      .text(text);
  }

  clearLabels() {
    this.labels = [];
    this.layer?.select('.labels').selectAll('*').remove();
  }

  /** Zoom so the country is clearly visible (used when revealing an answer). */
  focus(id: string) {
    this.focused = id;
    const els = this.nodes.get(id);
    if (!els?.length) return;
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
    for (const el of els) {
      const b = (el as SVGGraphicsElement).getBBox();
      x0 = Math.min(x0, b.x);
      y0 = Math.min(y0, b.y);
      x1 = Math.max(x1, b.x + b.width);
      y1 = Math.max(y1, b.y + b.height);
    }
    const bw = Math.max(x1 - x0, 1);
    const bh = Math.max(y1 - y0, 1);
    // Zoom in, but keep surrounding context: never more than 5x, and only if it's small.
    const k = Math.min(5, Math.max(1, 0.35 / Math.max(bw / this.width, bh / this.height)));
    if (k < 1.5 && this.k <= 1.5) return;
    const tx = this.width / 2 - k * (x0 + bw / 2);
    const ty = this.height / 2 - k * (y0 + bh / 2);
    this.svg.transition().duration(600).call(this.zoomer.transform, zoomIdentity.translate(tx, ty).scale(k));
  }

  resetZoom() {
    this.focused = null;
    this.svg?.transition().duration(400).call(this.zoomer.transform, zoomIdentity);
  }
}
