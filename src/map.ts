// Interactive SVG map: draws Natural Earth countries with D3, supports pinch
// zoom and pan, and gives tiny countries a tappable dot.
import { geoArea, geoCentroid, geoMercator, geoNaturalEarth1, geoPath, type GeoProjection } from 'd3-geo';
import { select, type Selection } from 'd3-selection';
import 'd3-transition';
import { easeCubicInOut, easeCubicOut } from 'd3-ease';
import { zoom, zoomIdentity, zoomTransform, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
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
const DOT_RADIUS = 5.1; // screen px
const TINY_AREA = 40; // px² at normal zoom, below which a country also gets a dot
const DOT_HIDE_AREA = 400; // px² on screen; once zoomed in this far, the dot is hidden
const RING_RADIUS = 14; // screen px, ring drawn around a revealed tiny country
const FOCUS_MS = 750; // zoom to a country
const RESET_MS = 650; // zoom back out to the whole region
const SETTLE_MS = 450; // finish a move after the map was resized (keyboard opening/closing)

type Box = { x: number; y: number; width: number; height: number };

/**
 * Projected box around a country's main landmass: its largest polygon plus any
 * sizable polygons touching it (North + South Island, but not the Kermadec or
 * Chatham Islands; the lower 48, but not Alaska or Hawaii).
 */
function mainBox(f: Shape, path: ReturnType<typeof geoPath>): Box | null {
  const g = f.geometry;
  const polys: Polygon[] =
    g.type === 'MultiPolygon' ? (g as MultiPolygon).coordinates.map((c) => ({ type: 'Polygon', coordinates: c })) : g.type === 'Polygon' ? [g as Polygon] : [];
  const parts = polys
    .map((p) => ({ area: path.area(p), b: path.bounds(p) }))
    .filter((p) => p.area > 0 && p.b.every((xy) => xy.every(Number.isFinite)));
  if (!parts.length) return null;
  parts.sort((a, b) => b.area - a.area);
  const [main] = parts;
  let [[x0, y0], [x1, y1]] = main.b;
  const near = (b: [[number, number], [number, number]], m: number) =>
    b[0][0] <= x1 + m && b[1][0] >= x0 - m && b[0][1] <= y1 + m && b[1][1] >= y0 - m;
  let rest = parts.slice(1).filter((p) => p.area >= main.area * 0.05);
  for (let grew = true; grew; ) {
    grew = false;
    const m = Math.max(x1 - x0, y1 - y0) * 0.1;
    rest = rest.filter((p) => {
      if (!near(p.b, m)) return true;
      [x0, y0, x1, y1] = [Math.min(x0, p.b[0][0]), Math.min(y0, p.b[0][1]), Math.max(x1, p.b[1][0]), Math.max(y1, p.b[1][1])];
      grew = true;
      return false;
    });
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

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
  private rings = new Set<string>();
  /** Screen position of each tiny country's dot (they get a ring when revealed). */
  private tinyXY = new Map<string, [number, number]>();
  private drawn = false;
  private tinyArea = new Map<string, number>();
  /** Box around each country's main landmass, for labels and zooming. */
  private mainBoxes = new Map<string, Box>();

  /** True while a country is still too small to see, so it's shown as a dot. */
  private showsDot(id: string) {
    return this.tinyXY.has(id) && (this.tinyArea.get(id) ?? 0) * this.k * this.k < DOT_HIDE_AREA;
  }
  private focused: string | null = null;

  constructor(private opts: MapOptions) {
    this.el = document.createElement('div');
    this.el.className = 'map';
    this.resizeObs = new ResizeObserver(() => {
      const { clientWidth: w, clientHeight: h } = this.el;
      if (w && h && (Math.abs(w - this.width) > 2 || Math.abs(h - this.height) > 2)) {
        clearTimeout(this.resizeTimer);
        // Wait for the keyboard to finish animating, then redraw for the new
        // size, picking up the view where it was (see render).
        this.resizeTimer = window.setTimeout(() => this.render(), 160);
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
    // On a redraw (the map was resized), remember what's on screen so the new
    // map can continue from exactly there instead of snapping back out.
    const prev = this.drawn ? this.viewState() : null;
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
    this.layer.append('g').attr('class', 'rings');
    this.layer.append('g').attr('class', 'labels');

    const tinyIds = new Set<string>();
    this.tinyXY.clear();
    this.tinyArea.clear();
    this.mainBoxes.clear();
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
          const box = mainBox(f, path);
          if (box) this.mainBoxes.set(id, box);
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
      this.tinyXY.set(id, xy as [number, number]);
      this.tinyArea.set(id, shapeArea.get(id) ?? 0);
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
        this.scaleOverlays();
      });
    this.svg.call(this.zoomer).on('dblclick.zoom', null);
    this.k = 1;
    for (const id of this.rings) this.drawRing(id);
    for (const [id, text, cls] of this.labels) this.drawLabel(id, text, cls);
    this.drawn = true;
    if (!prev) {
      if (this.focused) this.focus(this.focused);
      return;
    }
    // Same spot and size on screen as before the redraw, then glide on to
    // where the map should be.
    const t = this.restoreView(prev);
    this.svg.call(this.zoomer.transform, t);
    if (this.focused) this.focus(this.focused, SETTLE_MS, easeCubicOut);
    else if (prev.home) this.svg.transition().duration(SETTLE_MS).ease(easeCubicOut).call(this.zoomer.transform, zoomIdentity);
  }

  /** The geographic point at the center of the screen and the on-screen scale. */
  private viewState() {
    const t = zoomTransform(this.svg.node()!);
    const geo = this.projection.invert!(t.invert([this.width / 2, this.height / 2]));
    return {
      geo,
      scale: this.projection.scale() * t.k,
      home: !this.focused && Math.abs(t.k - 1) < 0.01 && Math.abs(t.x) < 1 && Math.abs(t.y) < 1,
    };
  }

  private restoreView(v: { geo: [number, number] | null; scale: number }): ZoomTransform {
    const p = v.geo && this.projection(v.geo);
    if (!p) return zoomIdentity;
    const k = v.scale / this.projection.scale();
    return zoomIdentity.translate(this.width / 2 - k * p[0], this.height / 2 - k * p[1]).scale(k);
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

  /** Bounding box of a country's main shape (or its dot), in map units. */
  private anchorBox(id: string): Box | null {
    const xy = this.tinyXY.get(id);
    if (xy && this.showsDot(id)) return { x: xy[0], y: xy[1], width: 0, height: 0 };
    const box = this.mainBoxes.get(id);
    if (box) return box;
    const c = COUNTRY_BY_ID.get(id)!;
    const shape = ALL_SHAPES.find((f) => f.properties.name === c.shapes[0]);
    const p = this.projection(c.point ?? (shape ? mainCentroid(shape) : [0, 0]));
    return p ? { x: p[0], y: p[1], width: 0, height: 0 } : null;
  }

  private drawLabel(id: string, text: string, cls: string) {
    // Sits just above the country (clear of its ring, if it has one) so the
    // country itself stays visible underneath its name.
    this.layer
      .select('.labels')
      .append('text')
      .datum({ id })
      .attr('text-anchor', 'middle')
      .attr('class', cls)
      .text(text);
    this.scaleOverlays();
  }

  /** A steady ring around a tiny country so it's easy to spot. */
  ring(id: string) {
    if (!this.tinyXY.has(id) || this.rings.has(id)) return;
    this.rings.add(id);
    this.drawRing(id);
  }

  private drawRing(id: string) {
    const xy = this.tinyXY.get(id);
    if (!xy) return;
    this.layer.select('.rings').append('circle').datum({ id }).attr('cx', xy[0]).attr('cy', xy[1]).attr('class', 'ring');
    this.scaleOverlays();
  }

  /** Keep labels and rings the same size on screen at any zoom. */
  private scaleOverlays() {
    const k = this.k;
    // A ring only while the country is dot-sized; once zoomed in, its red shape is enough.
    this.layer
      .selectAll<SVGCircleElement, { id: string }>('.rings circle')
      .attr('r', RING_RADIUS / k)
      .attr('display', (d) => (this.showsDot(d.id) ? null : 'none'));
    this.layer.selectAll<SVGTextElement, { id: string }>('.labels text').each((d, i, els) => {
      const b = this.anchorBox(d.id);
      if (!b) return;
      const ringed = this.rings.has(d.id) && this.showsDot(d.id);
      select(els[i])
        .attr('font-size', 15 / k)
        .attr('stroke-width', 3 / k)
        .attr('x', b.x + b.width / 2)
        .attr('y', b.y - ((ringed ? RING_RADIUS : 0) + 6) / k);
    });
  }

  /** Tone down every other labeled country so the answer stands out. */
  fadeOthers(keep: string) {
    for (const l of this.labels) {
      if (l[0] === keep) continue;
      l[2] = 'faded';
      this.mark(l[0], 'faded');
      this.rings.delete(l[0]);
    }
    if (!this.layer) return;
    this.layer.select('.labels').selectAll('*').remove();
    this.layer.select('.rings').selectAll('*').remove();
    for (const id of this.rings) this.drawRing(id);
    for (const [id, text, cls] of this.labels) this.drawLabel(id, text, cls);
  }

  clearLabels() {
    this.labels = [];
    this.rings.clear();
    this.layer?.select('.labels').selectAll('*').remove();
    this.layer?.select('.rings').selectAll('*').remove();
  }

  /** Zoom so the country is clearly visible (used when revealing an answer). */
  focus(id: string, ms = FOCUS_MS, ease = easeCubicInOut) {
    this.focused = id;
    if (!this.svg) return;
    // Frame the main landmass (or the dot), not far-off islands that belong to it.
    const b = this.anchorBox(id);
    if (!b) return;
    const bw = Math.max(b.width, 1);
    const bh = Math.max(b.height, 1);
    // Zoom in, but keep surrounding context: never more than 5x, and only if it's small.
    const k = Math.min(5, Math.max(1, 0.35 / Math.max(bw / this.width, bh / this.height)));
    const target =
      k < 1.5
        ? zoomIdentity
        : zoomIdentity.translate(this.width / 2 - k * (b.x + bw / 2), this.height / 2 - k * (b.y + bh / 2)).scale(k);
    this.svg.transition().duration(ms).ease(ease).call(this.zoomer.transform, target);
  }

  resetZoom() {
    this.focused = null;
    this.svg?.transition().duration(RESET_MS).ease(easeCubicInOut).call(this.zoomer.transform, zoomIdentity);
  }
}
