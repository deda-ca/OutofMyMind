// The weather plugin: current conditions and a short forecast for any place,
// from Open-Meteo (no API key). WEATHER_HOME is used when no place is given;
// WEATHER_UNITS is celsius (default) or fahrenheit.
//
// ⚠️ Unlike the rest of Jarvis this needs the internet: the place name and its
// coordinates are sent to open-meteo.com.

import { z } from 'zod'
import { createPlugin, failure, serve, text } from '../kit/plugin.ts'
import { OpenMeteo, WeatherError, describe, type Units } from './openMeteo.ts'

const home = process.env.WEATHER_HOME?.trim() || undefined
const defaultUnits: Units = process.env.WEATHER_UNITS?.trim().toLowerCase() === 'fahrenheit' ? 'fahrenheit' : 'celsius'
const weather = new OpenMeteo()

const plugin = createPlugin(
  'weather',
  '0.1.0',
  `Current weather and forecasts for any place.${home ? ` The owner lives in ${home}; use that when they don't name a place.` : ''}`,
)

plugin.registerTool(
  'get_weather',
  {
    description:
      'Current temperature and conditions, plus a daily forecast (min/max temperature, conditions, chance of precipitation), for a place. ' +
      'Give the city or town, and the province/state and country when known so the right place is found (there are many Kingstons).' +
      (home ? ` Leave location empty for the owner's home (${home}).` : ''),
    inputSchema: {
      location: z.string().optional().describe('City or town, e.g. "Kingston". "Kingston, Ontario, Canada" also works.'),
      region: z.string().optional().describe('Province, state or region, e.g. "Ontario".'),
      country: z.string().optional().describe('Country name or two-letter code, e.g. "Canada" or "CA".'),
      days: z.number().int().min(1).max(7).optional().describe('Days of forecast including today (1-7, default 2: today and tomorrow).'),
      units: z.enum(['celsius', 'fahrenheit']).optional().describe(`Default ${defaultUnits}.`),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ location, region, country, days, units }) => {
    try {
      const query = location?.trim() ? { location, region, country } : home ? { location: home } : undefined
      if (!query) return failure('Which place? No location was given and no home location is set (WEATHER_HOME).')
      const { place, others } = await weather.locate(query)
      const forecast = await weather.forecast(place, days ?? 2, units ?? defaultUnits)
      return text(describe(place, forecast, others))
    } catch (err) {
      if (err instanceof WeatherError) return failure(err.message)
      throw err
    }
  },
)

await serve(plugin)
