// The 197 countries the app teaches: 193 UN members plus Vatican City,
// Palestine, Kosovo and Taiwan. Grouped into the six regions used for study.

export type RegionId = 'africa' | 'asia' | 'europe' | 'north-america' | 'south-america' | 'oceania';

export interface Region {
  id: RegionId;
  name: string;
  /** Map view: [west, south, east, north] in degrees (east may exceed 180). */
  bbox: [number, number, number, number];
}

export const REGIONS: Region[] = [
  { id: 'africa', name: 'Africa', bbox: [-26, -36, 60, 38] },
  { id: 'asia', name: 'Asia', bbox: [25, -11, 150, 54] },
  { id: 'europe', name: 'Europe', bbox: [-25, 34, 50, 71] },
  { id: 'north-america', name: 'North America', bbox: [-168, 7, -52, 72] },
  { id: 'south-america', name: 'South America', bbox: [-92, -56, -33, 13] },
  { id: 'oceania', name: 'Oceania', bbox: [112, -48, 200, 20] },
];

export interface Country {
  /** Stable id (lowercase slug). */
  id: string;
  name: string;
  region: RegionId;
  /** Names of the shapes in the Natural Earth data that make up this country. */
  shapes: string[];
  /** Other accepted answers when typing. */
  aliases: string[];
  /** For countries missing from the map data: [lon, lat]. */
  point?: [number, number];
}

type Row = [name: string, shapes?: string | string[], aliases?: string[], point?: [number, number]];

const DATA: Record<RegionId, Row[]> = {
  africa: [
    ['Algeria'], ['Angola'], ['Benin'], ['Botswana'], ['Burkina Faso'], ['Burundi'],
    ['Cabo Verde', undefined, ['Cape Verde']], ['Cameroon'],
    ['Central African Republic', 'Central African Rep.', ['CAR']], ['Chad'], ['Comoros'],
    ['Republic of the Congo', 'Congo', ['Congo', 'Congo-Brazzaville', 'Congo Republic']],
    ['DR Congo', 'Dem. Rep. Congo', ['Democratic Republic of the Congo', 'DRC', 'Congo-Kinshasa', 'Zaire']],
    ['Djibouti'], ['Egypt'], ['Equatorial Guinea', 'Eq. Guinea'], ['Eritrea'],
    ['Eswatini', 'eSwatini', ['Swaziland']], ['Ethiopia'], ['Gabon'],
    ['Gambia', undefined, ['The Gambia']], ['Ghana'], ['Guinea'], ['Guinea-Bissau'],
    ["Côte d'Ivoire", undefined, ['Ivory Coast']], ['Kenya'], ['Lesotho'], ['Liberia'], ['Libya'],
    ['Madagascar'], ['Malawi'], ['Mali'], ['Mauritania'], ['Mauritius'], ['Morocco'],
    ['Mozambique'], ['Namibia'], ['Niger'], ['Nigeria'], ['Rwanda'],
    ['São Tomé and Príncipe', 'São Tomé and Principe', ['Sao Tome']], ['Senegal'], ['Seychelles'],
    ['Sierra Leone'], ['Somalia', ['Somalia', 'Somaliland']], ['South Africa'],
    ['South Sudan', 'S. Sudan'], ['Sudan'], ['Tanzania'], ['Togo'], ['Tunisia'], ['Uganda'],
    ['Zambia'], ['Zimbabwe'],
  ],
  asia: [
    ['Afghanistan'], ['Armenia'], ['Azerbaijan'], ['Bahrain'], ['Bangladesh'], ['Bhutan'],
    ['Brunei'], ['Cambodia'], ['China'], ['Georgia'], ['India'], ['Indonesia'], ['Iran'],
    ['Iraq'], ['Israel'], ['Japan'], ['Jordan'], ['Kazakhstan'], ['Kuwait'], ['Kyrgyzstan'],
    ['Laos'], ['Lebanon'], ['Malaysia'], ['Maldives'], ['Mongolia'],
    ['Myanmar', undefined, ['Burma']], ['Nepal'], ['North Korea', undefined, ['DPRK']], ['Oman'],
    ['Pakistan'], ['Palestine'], ['Philippines'], ['Qatar'], ['Saudi Arabia'], ['Singapore'],
    ['South Korea'], ['Sri Lanka'], ['Syria'], ['Taiwan'], ['Tajikistan'],
    ['Thailand'], ['Timor-Leste', undefined, ['East Timor']],
    ['Turkey', undefined, ['Türkiye', 'Turkiye']], ['Turkmenistan'],
    ['United Arab Emirates', undefined, ['UAE']], ['Uzbekistan'], ['Vietnam'], ['Yemen'],
  ],
  europe: [
    ['Albania'], ['Andorra'], ['Austria'], ['Belarus'], ['Belgium'],
    ['Bosnia and Herzegovina', 'Bosnia and Herz.', ['Bosnia']], ['Bulgaria'], ['Croatia'],
    ['Cyprus', ['Cyprus', 'N. Cyprus']], ['Czechia', undefined, ['Czech Republic']],
    ['Denmark'], ['Estonia'], ['Finland', ['Finland', 'Åland']], ['France'], ['Germany'],
    ['Greece'], ['Hungary'], ['Iceland'], ['Ireland'], ['Italy'], ['Kosovo'], ['Latvia'],
    ['Liechtenstein'], ['Lithuania'], ['Luxembourg'], ['Malta'], ['Moldova'], ['Monaco'],
    ['Montenegro'], ['Netherlands', undefined, ['Holland']],
    ['North Macedonia', 'Macedonia', ['Macedonia']], ['Norway'], ['Poland'], ['Portugal'],
    ['Romania'], ['Russia'], ['San Marino'], ['Serbia'], ['Slovakia'], ['Slovenia'], ['Spain'],
    ['Sweden'], ['Switzerland'], ['Ukraine'],
    ['United Kingdom', undefined, ['UK', 'Great Britain', 'Britain']],
    ['Vatican City', 'Vatican', ['Vatican', 'Holy See']],
  ],
  'north-america': [
    ['Antigua and Barbuda', 'Antigua and Barb.'], ['Bahamas', undefined, ['The Bahamas']],
    ['Barbados'], ['Belize'], ['Canada'], ['Costa Rica'], ['Cuba'], ['Dominica'],
    ['Dominican Republic', 'Dominican Rep.'], ['El Salvador'], ['Grenada'], ['Guatemala'],
    ['Haiti'], ['Honduras'], ['Jamaica'], ['Mexico'], ['Nicaragua'], ['Panama'],
    ['Saint Kitts and Nevis', 'St. Kitts and Nevis'], ['Saint Lucia'],
    ['Saint Vincent and the Grenadines', 'St. Vin. and Gren.'], ['Trinidad and Tobago'],
    ['United States', 'United States of America', ['USA', 'US', 'United States of America', 'America']],
  ],
  'south-america': [
    ['Argentina'], ['Bolivia'], ['Brazil'], ['Chile'], ['Colombia'], ['Ecuador'], ['Guyana'],
    ['Paraguay'], ['Peru'], ['Suriname'], ['Uruguay'], ['Venezuela'],
  ],
  oceania: [
    ['Australia'], ['Fiji'], ['Kiribati'], ['Marshall Islands', 'Marshall Is.'],
    ['Micronesia', undefined, ['Federated States of Micronesia', 'FSM']], ['Nauru'],
    ['New Zealand'], ['Palau'], ['Papua New Guinea', undefined, ['PNG']], ['Samoa'],
    ['Solomon Islands', 'Solomon Is.'], ['Tonga'], ['Tuvalu', [], [], [179.2, -8.5]], ['Vanuatu'],
  ],
};

const slug = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export const COUNTRIES: Country[] = (Object.keys(DATA) as RegionId[]).flatMap((region) =>
  DATA[region].map(([name, shapes, aliases, point]) => ({
    id: slug(name),
    name,
    region,
    shapes: shapes === undefined ? [name] : Array.isArray(shapes) ? shapes : [shapes],
    aliases: aliases ?? [],
    point,
  })),
);

export const COUNTRY_BY_ID = new Map(COUNTRIES.map((c) => [c.id, c]));

/** Natural Earth shape name -> country id. */
export const SHAPE_TO_COUNTRY = new Map<string, string>(
  COUNTRIES.flatMap((c) => c.shapes.map((s) => [s, c.id] as [string, string])),
);

export const regionCountries = (r: RegionId) => COUNTRIES.filter((c) => c.region === r);

/** Normalise typed answers: case, accents, punctuation, "saint"/"st", leading "the". */
export function normalizeAnswer(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bst\.?\s/g, 'saint ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the /, '');
}

const ANSWERS = new Map<string, string>();
for (const c of COUNTRIES) {
  for (const a of [c.name, ...c.aliases]) ANSWERS.set(normalizeAnswer(a), c.id);
}

/** Returns the country id a typed answer refers to, or undefined. */
export function matchAnswer(typed: string): string | undefined {
  return ANSWERS.get(normalizeAnswer(typed));
}
