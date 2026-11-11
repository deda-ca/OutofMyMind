// Weather from Open-Meteo (https://open-meteo.com): free, no account or key.
// A place name is looked up with its geocoding API, then the forecast is
// fetched for those coordinates. Only the place name and coordinates leave
// this machine.

export type Units = 'celsius' | 'fahrenheit'

export interface Place {
  name: string
  region?: string
  country?: string
  countryCode?: string
  latitude: number
  longitude: number
}

export interface PlaceQuery {
  /** A city or town, e.g. "Kingston". May also be "Kingston, Ontario, Canada". */
  location: string
  /** Province, state or region, e.g. "Ontario". */
  region?: string
  /** Country name or two-letter code, e.g. "Canada" or "CA". */
  country?: string
}

type Fetch = typeof fetch

const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'
const TIMEOUT_MS = 10_000

/** Common spoken/written country names the geocoder's names don't match. */
const COUNTRY_ALIASES: Record<string, string> = {
  usa: 'US',
  'united states of america': 'US',
  america: 'US',
  uk: 'GB',
  britain: 'GB',
  'great britain': 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
}

export class WeatherError extends Error {}

export class OpenMeteo {
  private readonly fetch: Fetch
  private readonly places = new Map<string, { place: Place; others: Place[] }>()

  constructor(fetchImpl: Fetch = fetch) {
    this.fetch = fetchImpl
  }

  /** Finds the place; `others` are other places with that name (if the query was ambiguous). */
  async locate(query: PlaceQuery): Promise<{ place: Place; others: Place[] }> {
    const q = normalise(query)
    const key = JSON.stringify(q)
    const cached = this.places.get(key)
    if (cached) return cached

    const params = new URLSearchParams({ name: q.location, count: '20', language: 'en', format: 'json' })
    const code = q.country ? countryCode(q.country) : undefined
    if (code) params.set('countryCode', code)
    const data = (await this.get(`${GEOCODING_URL}?${params}`)) as { results?: GeoResult[] }
    let candidates = (data.results ?? []).map(toPlace)
    if (q.country && !code) candidates = candidates.filter((p) => matches(p.country, q.country!))
    // The region also matches a country: "Paris, France" arrives as location + region.
    if (q.region) candidates = candidates.filter((p) => matches(p.region, q.region!) || matches(p.admin2, q.region!) || matches(p.country, q.region!))
    if (candidates.length === 0) {
      const where = [q.location, q.region, q.country].filter(Boolean).join(', ')
      throw new WeatherError(`I couldn't find a place called "${where}". Check the spelling, or give the province/state and country.`)
    }
    const [place, ...rest] = candidates.map(({ admin2: _, ...p }) => p)
    // Only mention alternatives when the caller didn't narrow it down.
    const result = { place, others: q.region || q.country ? [] : rest.slice(0, 3) }
    this.places.set(key, result)
    return result
  }

  async forecast(place: Place, days: number, units: Units): Promise<Forecast> {
    const params = new URLSearchParams({
      latitude: String(place.latitude),
      longitude: String(place.longitude),
      current: 'temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation',
      daily: 'temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max,precipitation_sum',
      timezone: 'auto',
      forecast_days: String(days),
      temperature_unit: units,
      wind_speed_unit: units === 'fahrenheit' ? 'mph' : 'kmh',
      precipitation_unit: units === 'fahrenheit' ? 'inch' : 'mm',
    })
    return (await this.get(`${FORECAST_URL}?${params}`)) as Forecast
  }

  private async get(url: string): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
    } catch (err) {
      throw new WeatherError(`The weather service couldn't be reached: ${(err as Error).message}`)
    }
    const body = (await response.json().catch(() => ({}))) as { reason?: string }
    if (!response.ok) throw new WeatherError(`The weather service said: ${body.reason ?? `HTTP ${response.status}`}`)
    return body
  }
}

interface GeoResult {
  name: string
  latitude: number
  longitude: number
  country?: string
  country_code?: string
  admin1?: string
  admin2?: string
}

export interface Forecast {
  timezone: string
  current_units: Record<string, string>
  current: { time: string; temperature_2m: number; apparent_temperature: number; relative_humidity_2m: number; weather_code: number; wind_speed_10m: number; precipitation: number }
  daily_units: Record<string, string>
  daily: {
    time: string[]
    temperature_2m_max: number[]
    temperature_2m_min: number[]
    weather_code: number[]
    precipitation_probability_max: (number | null)[]
    precipitation_sum: (number | null)[]
  }
}

/** A short plain-text report for the model to speak from. */
export function describe(place: Place, forecast: Forecast, others: Place[] = []): string {
  const c = forecast.current
  const u = forecast.current_units
  const deg = u.temperature_2m ?? '°'
  const lines = [
    `${placeName(place)} (local time ${c.time.replace('T', ' ')}, ${forecast.timezone})`,
    `Now: ${round(c.temperature_2m)}${deg}, feels like ${round(c.apparent_temperature)}${deg}, ${condition(c.weather_code)}, humidity ${c.relative_humidity_2m}%, wind ${round(c.wind_speed_10m)} ${u.wind_speed_10m}${c.precipitation > 0 ? `, ${c.precipitation} ${u.precipitation} of precipitation` : ''}.`,
  ]
  const d = forecast.daily
  d.time.forEach((date, i) => {
    const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : weekday(date)
    const chance = d.precipitation_probability_max[i]
    lines.push(
      `${label} (${date}): ${round(d.temperature_2m_min[i])} to ${round(d.temperature_2m_max[i])}${deg}, ${condition(d.weather_code[i])}${chance != null ? `, ${chance}% chance of precipitation` : ''}.`,
    )
  })
  if (others.length > 0) lines.push(`(Other places with that name: ${others.map(placeName).join('; ')}. Ask if the owner meant one of those.)`)
  return lines.join('\n')
}

export function placeName(place: Place): string {
  return [place.name, place.region !== place.name ? place.region : undefined, place.country].filter(Boolean).join(', ')
}

/** WMO weather interpretation codes, as Open-Meteo documents them. */
export function condition(code: number): string {
  const names: Record<number, string> = {
    0: 'clear sky',
    1: 'mainly clear',
    2: 'partly cloudy',
    3: 'overcast',
    45: 'fog',
    48: 'freezing fog',
    51: 'light drizzle',
    53: 'drizzle',
    55: 'heavy drizzle',
    56: 'light freezing drizzle',
    57: 'freezing drizzle',
    61: 'light rain',
    63: 'rain',
    65: 'heavy rain',
    66: 'light freezing rain',
    67: 'freezing rain',
    71: 'light snow',
    73: 'snow',
    75: 'heavy snow',
    77: 'snow grains',
    80: 'light rain showers',
    81: 'rain showers',
    82: 'violent rain showers',
    85: 'light snow showers',
    86: 'heavy snow showers',
    95: 'thunderstorm',
    96: 'thunderstorm with light hail',
    99: 'thunderstorm with heavy hail',
  }
  return names[code] ?? `weather code ${code}`
}

/** "Kingston, Ontario, Canada" in one field → location/region/country. */
function normalise(query: PlaceQuery): PlaceQuery {
  const parts = query.location.split(',').map((s) => s.trim()).filter(Boolean)
  const location = parts[0] ?? ''
  if (!location) throw new WeatherError('Which place? Give a city or town.')
  let region = query.region?.trim() || undefined
  let country = query.country?.trim() || undefined
  if (parts.length >= 3) {
    region ??= parts[1]
    country ??= parts[2]
  } else if (parts.length === 2) {
    // "Paris, FR" (a code) is a country; "Kingston, Ontario" or "Paris, France" is matched as a region or country.
    if (!country && countryCode(parts[1])) country = parts[1]
    else region ??= parts[1]
  }
  return { location, region, country }
}

/** A two-letter code if the text is one (or a known alias); otherwise undefined (match by name). */
function countryCode(country: string): string | undefined {
  const text = country.trim()
  if (/^[A-Za-z]{2}$/.test(text)) return text.toUpperCase()
  return COUNTRY_ALIASES[text.toLowerCase().replaceAll('.', '')]
}

function matches(value: string | undefined, wanted: string): boolean {
  if (!value) return false
  const a = fold(value)
  const b = fold(wanted)
  return a === b || a.startsWith(b) || b.startsWith(a)
}

/** Case- and accent-insensitive ("Québec" = "quebec"). */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()
}

function toPlace(r: GeoResult): Place & { admin2?: string } {
  return { name: r.name, region: r.admin1, admin2: r.admin2, country: r.country, countryCode: r.country_code, latitude: r.latitude, longitude: r.longitude }
}

function round(n: number): number {
  return Math.round(n)
}

function weekday(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-CA', { weekday: 'long', timeZone: 'UTC' })
}
