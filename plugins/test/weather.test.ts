import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OpenMeteo, WeatherError, condition, describe, type Forecast } from '../weather/openMeteo.ts'

const KINGSTONS = [
  { name: 'Kingston', latitude: 17.99, longitude: -76.79, country: 'Jamaica', country_code: 'JM', admin1: 'Kingston' },
  { name: 'Kingston', latitude: 44.23, longitude: -76.48, country: 'Canada', country_code: 'CA', admin1: 'Ontario', admin2: 'Frontenac County' },
  { name: 'Kingston', latitude: 41.93, longitude: -74.0, country: 'United States', country_code: 'US', admin1: 'New York' },
]

/** A fake fetch answering geocoding with `results`; records the URLs asked for. */
function fakeFetch(results: unknown[], urls: string[] = []): typeof fetch {
  return (async (url: string) => {
    urls.push(url)
    return new Response(JSON.stringify({ results }), { status: 200 })
  }) as typeof fetch
}

test('the province or country picks the right place', async () => {
  const meteo = new OpenMeteo(fakeFetch(KINGSTONS))
  assert.equal((await meteo.locate({ location: 'Kingston', region: 'ontario' })).place.country, 'Canada')
  assert.equal((await meteo.locate({ location: 'Kingston, New York' })).place.region, 'New York')
  assert.equal((await meteo.locate({ location: 'Kingston', country: 'Canada' })).place.region, 'Ontario')
  assert.equal((await meteo.locate({ location: 'Kingston, Ontario, Canada' })).place.latitude, 44.23)
  assert.equal((await meteo.locate({ location: 'Kingston, United States' })).place.region, 'New York')
})

test('an ambiguous name takes the best match and mentions the others', async () => {
  const { place, others } = await new OpenMeteo(fakeFetch(KINGSTONS)).locate({ location: 'Kingston' })
  assert.equal(place.country, 'Jamaica')
  assert.deepEqual(others.map((o) => o.country), ['Canada', 'United States'])
})

test('two-letter codes and aliases are sent as countryCode', async () => {
  const urls: string[] = []
  const meteo = new OpenMeteo(fakeFetch([KINGSTONS[2]], urls))
  await meteo.locate({ location: 'Kingston', country: 'USA' })
  await meteo.locate({ location: 'Kingston, us' })
  assert.match(urls[0], /countryCode=US/)
  assert.match(urls[1], /countryCode=US/)
})

test('unknown places and outages are clear errors', async () => {
  await assert.rejects(new OpenMeteo(fakeFetch(KINGSTONS)).locate({ location: 'Kingston', region: 'Quebec' }), /couldn't find a place called "Kingston, Quebec"/)
  await assert.rejects(new OpenMeteo(fakeFetch([])).locate({ location: ' ' }), WeatherError)
  const down = (async () => {
    throw new Error('ENOTFOUND')
  }) as unknown as typeof fetch
  await assert.rejects(new OpenMeteo(down).locate({ location: 'Ottawa' }), /couldn't be reached/)
})

test('the report reads well', () => {
  const forecast: Forecast = {
    timezone: 'America/Toronto',
    current_units: { temperature_2m: '°C', wind_speed_10m: 'km/h', precipitation: 'mm' },
    current: { time: '2026-11-06T15:30', temperature_2m: 13.7, apparent_temperature: 13.9, relative_humidity_2m: 91, weather_code: 3, wind_speed_10m: 3.4, precipitation: 0 },
    daily_units: {},
    daily: { time: ['2026-11-06', '2026-11-07'], temperature_2m_max: [13.8, 10.9], temperature_2m_min: [9.4, 6.4], weather_code: [51, 61], precipitation_probability_max: [26, 80], precipitation_sum: [0.2, 4] },
  }
  const place = { name: 'Kingston', region: 'Ontario', country: 'Canada', latitude: 44.23, longitude: -76.48 }
  assert.equal(
    describe(place, forecast),
    [
      'Kingston, Ontario, Canada (local time 2026-11-06 15:30, America/Toronto)',
      'Now: 14°C, feels like 14°C, overcast, humidity 91%, wind 3 km/h.',
      'Today (2026-11-06): 9 to 14°C, light drizzle, 26% chance of precipitation.',
      'Tomorrow (2026-11-07): 6 to 11°C, light rain, 80% chance of precipitation.',
    ].join('\n'),
  )
  assert.equal(condition(1234), 'weather code 1234')
})
