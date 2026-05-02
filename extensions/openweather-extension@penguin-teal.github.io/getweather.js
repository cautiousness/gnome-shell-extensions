/*
  Copyright 2024 Teal Penguin

  This program is free software: you can redistribute it and/or modify
  it under the terms of the GNU General Public License as published by
  the Free Software Foundation, either version 3 of the License, or
  (at your option) any later version.

  This program is distributed in the hope that it will be useful,
  but WITHOUT ANY WARRANTY; without even the implied warranty of
  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
  GNU General Public License for more details.

  You should have received a copy of the GNU General Public License
  along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

import GLib from "gi://GLib";
import Soup from "gi://Soup";
import { getSoupSession, getDirectSoupSession } from "./myloc.js"
import { getIconName, gettextCondition } from "./weathericons.js"

const QWEATHER_JWT_HELPER = GLib.build_filenamev([GLib.get_home_dir(), ".config", "qweather", "qweather-jwt.sh"]);
const QWEATHER_CONFIG = GLib.build_filenamev([GLib.get_home_dir(), ".config", "qweather", "qweather.env"]);

export const DEFAULT_KEYS =
[
  "b4d6a638dd4af5e668ccd8574fd90cec",
  "7a4baea97ef946c7864221259240804",
  "ES25QFD3CP93EZ9DMSJ72MAX7",
  ""
];

export class TooManyReqError extends Error
{
  provider;
  constructor(provider)
  {
    super(`Provider ${getWeatherProviderName(provider)} has received too many requests.`);
    this.provider = provider;
    this.name = "TooManyReqError";
  }
}

/**
  * @enum {number}
  */
export const WeatherProvider =
{
  DEFAULT: 0,
  OPENWEATHERMAP: 1,
  WEATHERAPICOM: 2,
  VISUALCROSSING: 3,
  QWEATHER: 4,
  OPENMETEO: 5,

  // Open-Meteo not ready
  /** Count of usable providers (excludes Adaptive). */
  COUNT: 4
};

// Corresponds to Weather providers
export const ForecastDaysSupport =
{
  0: 0,
  1: 4,
  2: 2,
  3: 14,
  4: 7,
  5: 15
}

export function getWeatherProviderName(prov)
{
  switch(prov)
  {
    case WeatherProvider.OPENWEATHERMAP:
      return "OpenWeatherMap";
    case WeatherProvider.WEATHERAPICOM:
      return "WeatherAPI.com";
    case WeatherProvider.VISUALCROSSING:
      return "Visual Crossing";
    case WeatherProvider.QWEATHER:
      return "QWeather";
    case WeatherProvider.OPENMETEO:
      return "Open-Meteo";
    default:
      return null;
  }
}

export function getWeatherProviderUrl(prov)
{
  switch(prov)
  {
    case WeatherProvider.OPENWEATHERMAP:
      return "https://openweathermap.org/";
    case WeatherProvider.WEATHERAPICOM:
      return "https://www.weatherapi.com/";
    case WeatherProvider.VISUALCROSSING:
      return "https://www.visualcrossing.com/";
    case WeatherProvider.QWEATHER:
      return "https://www.qweather.com/";
    case WeatherProvider.OPENMETEO:
      return "https://open-meteo.com/";
    default:
      return null;
  }
}

/**
  * Convert a string in the form of '00:00 AM/PM' to milliseconds since
  * 12:00 AM (0:00).
  * @param {string} timeString
  * @returns {number}
  */
function timeToMs(timeString)
{
  let isPm = timeString.endsWith("PM");
  let m = timeString.match(/^([0-9]{2}):([0-9]{2})/);
  return m[1] * 3600000 + m[2] * 60000 + (isPm ? 12 * 3600000 : 0);
}

// Choose a random provider each time to try to avoid rate limiting
let randomProvider = 0;
function chooseRandomProvider(settings)
{
  // WeatherAPI.com doesn't support as many forecast days as OpenWeatherMap
  let forecastDays = settings.get_int("days-forecast");
  let rand = Math.floor(Math.random() * WeatherProvider.COUNT + 1);

  // Should be OpenMeteo in the future
  if(ForecastDaysSupport[rand] < forecastDays) rand = WeatherProvider.OPENWEATHERMAP;
  
  randomProvider = rand;
  // Visual Crossing doesn't work right now (blocked if reached rate limit)
  if(rand === WeatherProvider.VISUALCROSSING) weatherProviderNotWorking(settings);
}

export function getWeatherProvider(settings)
{
  let prov = settings.get_enum("weather-provider");
  if(prov === WeatherProvider.DEFAULT)
  {
    if(!randomProvider) chooseRandomProvider(settings);
    return randomProvider;
  }
  else return prov;
}

let providerNotWorking = 0;
/**
  * Cycles the weather provider if weather provider is in random mode.
  * @returns {boolean} `true` if the weather provider changed and the operation
  *                    should be tried again, otherwise `false` if nothing changed.
  */
export function weatherProviderNotWorking(settings)
{
  let prov = settings.get_enum("weather-provider");
  if(prov === WeatherProvider.DEFAULT)
  {
    if(!providerNotWorking) providerNotWorking = randomProvider;
    // if we've already cycled through them all, give up
    else if(randomProvider === providerNotWorking) return false;

    randomProvider++;

    // Visual Crossing doesn't work right now (blocked if reached rate limit)
    if(randomProvider === WeatherProvider.VISUALCROSSING) randomProvider++;

    if(randomProvider > WeatherProvider.COUNT) randomProvider = 1;

    console.log("inc rand " + typeof randomProvider + randomProvider);

    return true;
  }
  else return false;
}

export class Weather
{
  #iconName;
  #condition;

  #tempC;
  #feelsLikeC;
  #humidityPercent;
  #pressureMBar;
  #windMps;
  #windDirDeg;
  #gustsMps;

  #sunrise;
  #sunset;

  #forecasts;

  /**
    * @param {number} tempC 
    * @param {number} feelsLikeC
    * @param {number} humidityPercent
    * @param {number} pressureMBar
    * @param {number} windMps
    * @param {number} windDirDeg
    * @param {number} gustsMps
    * @param {string} iconName
    * @param {string} condition
    * @param {Date} sunrise
    * @param {Date} sunset
    * @param {(Forecast[][] | null)} forecasts
    */
  constructor(tempC, feelsLikeC, humidityPercent, pressureMBar, windMps, windDirDeg, gustsMps, iconName, condition, sunrise, sunset, forecasts = null)
  {
    this.#tempC = tempC;
    this.#feelsLikeC = feelsLikeC;
    this.#humidityPercent = humidityPercent;
    this.#pressureMBar = pressureMBar;
    this.#windMps = windMps;
    this.#windDirDeg = windDirDeg;
    this.#gustsMps = gustsMps;
    this.#iconName = iconName;
    this.#sunrise = sunrise;
    this.#sunset = sunset;
    this.#forecasts = forecasts ? forecasts.length > 0 ? forecasts : null : null;

    if(typeof condition === "string") this.#condition = condition;
    else throw new Error(`OpenWeather Refined Weather Condition '${condition}' was type '${typeof condition}' not string.`);
  }

  /**
    * @returns {string}
    */
  getIconName()
  {
    return this.#iconName;
  }

  /**
    * @returns {string}
    */
  displayCondition()
  {
    return this.#condition;
  }

  /**
    * @returns {string}
    */
  displayTemperature(extension)
  {
    return extension.formatTemperature(this.#tempC);
  }

  /**
    * @returns {string}
    */
  displayFeelsLike(extension)
  {
    return extension.formatTemperature(this.#feelsLikeC);
  }

  /**
    * @returns {string}
    */
  displayHumidity()
  {
    return `${this.#humidityPercent}%`;
  }

  /**
    * @returns {string}
    */
  displayPressure(extension)
  {
    return extension.formatPressure(this.#pressureMBar);
  }

  /**
    * @returns {string}
    */
  displayWind(extension)
  {
    let dir = extension.getWindDirection(this.#windDirDeg);
    return extension.formatWind(this.#windMps, dir);
  }

  /**
    * @returns {string}
    */
  displayGusts(extension)
  {
    return extension.formatWind(this.#gustsMps);
  }

  /**
    * @returns {boolean}
    */
  gustsAvailable()
  {
    return typeof this.#gustsMps === "number";
  }

  /**
    * @returns {string}
    */
  displaySunrise(extension)
  {
    return extension.formatTime(this.#sunrise);
  }

  /**
    * @returns {Date}
    */
  getSunriseDate()
  {
    return this.#sunrise;
  }

  /**
    * @returns {string}
    */
  displaySunset(extension)
  {
    return extension.formatTime(this.#sunset);
  }

  /**
    * @returns {Date}
    */
  getSunsetDate()
  {
    return this.#sunset;
  }

  hasForecast()
  {
    return this.#forecasts !== null;
  }

  forecastDayCount()
  {
    return this.#forecasts.length;
  }

  forecastHourCount(dayIndex)
  {
    return this.#forecasts[dayIndex].length;
  }

  forecastDayHour(dayIndex, hourIndex)
  {
    return this.#forecasts[dayIndex][hourIndex];
  }

  forecastAtHour(dayIndex, hoursFromNow)
  {
    let day = this.#forecasts[dayIndex];
    return day[hoursFromNow / day[0].getDurationHours()];
  }

  forecastHoursFromNow(hoursFromNow)
  {
    let future = new Date().getTime() + 3600000 * hoursFromNow;
    let days = this.#forecasts.length;
    for(let i = 0; i < days; i++)
    {
      let d = this.#forecasts[i];
      let h = d[d.length - 1];
      let endTime = h.getEnd().getTime();

      if(future > endTime) continue;

      let distanceHrs = (future - d[0].getStart().getTime()) / 3600000;
      let index = Math.ceil(distanceHrs / h.getDurationHours());
      if(index >= this.#forecasts[i].length) index = this.#forecasts[i].length - 1;
      return this.#forecasts[i][index];
    }

    let lastDay = this.#forecasts[days - 1];
    return lastDay[lastDay.length - 1];
  }

}

export class Forecast
{
  #start;
  #end;
  #weather;

  /**
    * @param {Date} start 
    * @param {Date} end 
    * @param {Weather} weather 
    */
  constructor(start, end, weather)
  {
    this.#start = start;
    this.#end = end;
    this.#weather = weather;
  }

  getStart()
  {
    return this.#start;
  }

  getEnd()
  {
    return this.#end;
  }

  getDurationHours()
  {
    return (this.#end - this.#start) / 3600000;
  }

  displayTime(extension)
  {
    return extension.formatTime(this.#start);
  }

  weather()
  {
    return this.#weather;
  }
}

function getQWeatherJwt()
{
  try
  {
    let [ok, stdout, stderr, status] = GLib.spawn_command_line_sync(QWEATHER_JWT_HELPER);
    if(!ok || status !== 0)
    {
      let err = stderr ? new TextDecoder().decode(stderr).trim() : "";
      console.error(`OpenWeather Refined: QWeather JWT helper failed: ${err}`);
      return "";
    }

    return new TextDecoder().decode(stdout).trim();
  }
  catch(e)
  {
    console.error(`OpenWeather Refined: QWeather JWT helper failed: ${e}`);
    return "";
  }
}

function getQWeatherApiBase()
{
  try
  {
    let file = GLib.file_get_contents(QWEATHER_CONFIG);
    if(!file[0]) return "";

    let text = new TextDecoder().decode(file[1]);
    for(let line of text.split("\n"))
    {
      let match = line.match(/^QWEATHER_API_HOST=(.*)$/);
      if(!match) continue;

      let host = match[1].trim().replace(/^['"]|['"]$/g, "");
      if(!host) return "";
      if(!/^https?:\/\//.test(host)) host = `https://${host}`;
      return host.replace(/\/+$/, "");
    }
  }
  catch(e)
  {
    console.error(`OpenWeather Refined: Failed to read QWeather config: ${e}`);
  }

  return "";
}

async function loadJsonAsync(url, params, headers = null, direct = false)
{
  return new Promise((resolve, reject) =>
  {
    let httpSession = direct ? getDirectSoupSession() : getSoupSession();
    let paramsHash = Soup.form_encode_hash(params);
    let message = Soup.Message.new_from_encoded_form("GET", url, paramsHash);
    if(headers)
    {
      for(let [key, value] of Object.entries(headers))
      {
        message.get_request_headers().append(key, value);
      }
    }

    httpSession.send_and_read_async(
      message,
      GLib.PRIORITY_DEFAULT,
      null,
      (sess, result) =>
      {
        let bytes = sess.send_and_read_finish(result);

        let jsonString = bytes.get_data();
        if (jsonString instanceof Uint8Array)
        {
          jsonString = new TextDecoder().decode(jsonString);
        }

        try
        {
          if (!jsonString)
          {
            reject("No data in response body.");
          }
          resolve([message.status_code, JSON.parse(jsonString)]);
        }
        catch(e)
        {
          sess.abort();
          reject(e);
        }
      }
    );
  });
}

function isSuccess(httpStatusCode)
{
  return httpStatusCode >= 200 && httpStatusCode < 300;
}

function clamp(lo, x, hi)
{
  return Math.min(Math.max(lo, x), hi);
}

function getCondit(extension, code, condition, gettext)
{
  if(!extension._translate_condition || extension._providerTranslations || !gettext)
  {
    return condition;
  }
  else
  {
    return gettextCondition(getWeatherProvider(extension.settings), code, gettext);
  }
}

function qweatherIconName(code)
{
  const n = Number.parseInt(code, 10);
  if (n === 100 || n === 150) return "weather-clear-symbolic";
  if ([101, 102, 103, 151, 152, 153].includes(n)) return "weather-few-clouds-symbolic";
  if ([104, 154].includes(n)) return "weather-overcast-symbolic";
  if (n >= 200 && n < 300) return "weather-windy-symbolic";
  if (n >= 300 && n < 400) return [302, 303, 304].includes(n) ? "weather-storm-symbolic" : "weather-showers-symbolic";
  if (n >= 400 && n < 500) return "weather-snow-symbolic";
  if (n >= 500 && n < 600) return "weather-fog-symbolic";
  if (n >= 700 && n < 800) return "weather-fog-symbolic";
  if (n >= 900 && n < 1000) return "weather-clear-symbolic";
  return "weather-few-clouds-symbolic";
}

function parseQWeatherTime(value)
{
  if (!value) return new Date();
  if (/^\d{2}:\d{2}$/.test(value)) {
    const date = new Date();
    const [hours, minutes] = value.split(":").map(Number);
    date.setHours(hours, minutes, 0, 0);
    return date;
  }

  return new Date(value);
}

/**
  * @returns {Promise<Weather | null>}
  */
export async function getWeatherInfo(extension, gettext)
{
  const settings = extension.settings;

  let location = await extension._city.getCoords(settings);
  let lat = String(location[0]);
  let lon = String(location[1]);

  let params;
  switch(getWeatherProvider(extension.settings))
  {
    case WeatherProvider.OPENWEATHERMAP:
      {
        params =
        {
          lat,
          lon,
          units: "metric"
        };
        if(extension._providerTranslations) params.lang = extension.locale;
        let apiKey = extension.getWeatherKey();
        if(apiKey) params.appid = apiKey;

        let response;
        let forecastResponse;
        try
        {
          let cur = loadJsonAsync("https://api.openweathermap.org/data/2.5/weather", params);
          let fore = loadJsonAsync("https://api.openweathermap.org/data/2.5/forecast", params);
          let allResp = await Promise.all([ cur, fore ]);
          response = allResp[0];
          forecastResponse = allResp[1];
        }
        catch(e)
        {
          console.error(`OpenWeather Refined: Failed to fetch weather from OpenWeatherMap ('${e.message}').`);
          return null;
        }

        if(!isSuccess(response[0]) || !isSuccess(forecastResponse[0]))
        {
          console.error(`OpenWeather Refined: Invalid API Response from OpenWeatherMap ` +
            `${response[0]}/${forecastResponse[0]}: '${response[1]?.message}'` +
            `/'${forecastResponse[1]?.message}'.`);

          if(response[0] === 429 || forecastResponse[0] === 429) throw new TooManyReqError(WeatherProvider.OPENWEATHERMAP);
          else return null;
        }

        let json = response[1];
        let m = json.main;
        let iconId = json.weather[0].icon;

        // OpenWeatherMap bug? Sunrise/sunset seconds seems to always return
        // for same day even if sunrise is tomorrow morning. Therefore just
        // subtract today and we'll decide if it's tomorrow or not
        let thisMorningMs = new Date().setHours(0, 0, 0, 0);
        let midnightMs = thisMorningMs + 3600000 * 24;
        let sunriseMs = json.sys.sunrise * 1000 - thisMorningMs;
        let sunsetMs = json.sys.sunset * 1000 - thisMorningMs;

        let sunrise, sunset;
        // "pod" = Part of Day, "d" = day, "n" = night
        if(forecastResponse[1].list[0].sys.pod === "d")
        {
          sunrise = new Date(sunriseMs + midnightMs);
          sunset  = new Date(sunsetMs  + thisMorningMs);
        }
        else
        {
          sunrise = new Date(sunriseMs + thisMorningMs);
          sunset  = new Date(sunsetMs  + midnightMs);
        }

        let forecastDays = clamp(1, extension._days_forecast + 1, 5);
        extension._forecastDays = forecastDays - 1;

        let forecasts = [ ];
        for(let i = 0; i < forecastDays; i++)
        {
          let day = [ ];
          for(let j = 0; j < 8; j++)
          {
            let h = forecastResponse[1].list[i * 8 + j];
            let fIconId = h.weather[0].icon;
            let isFNight = fIconId[fIconId.length - 1] === "n";

            // Create Date from UTC timestamp
            let match = h.dt_txt.match(/^([0-9]{4})-([0-9]{2})-([0-9]{2}) ([0-9]{2}):/);
            let dt = new Date(Date.UTC(match[1], match[2] - 1, match[3], match[4]));

            day.push(new Forecast(
              dt,
              new Date(dt.getTime() + 3600000 * 3),
              new Weather(
                h.main.temp,
                h.main.feels_like,
                h.main.humidity,
                h.main.pressure,
                h.wind?.speed,
                h.wind?.deg,
                h.wind?.gust,
                getIconName(WeatherProvider.OPENWEATHERMAP, fIconId, isFNight, true),
                getCondit(extension, h.weather[0].id, h.weather[0].description, gettext),
                sunrise,
                sunset
              )
            ));
          }
          forecasts.push(day);
        }

        return new Weather(
          m.temp,
          m.feels_like,
          m.humidity,
          m.pressure,
          json.wind?.speed,
          json.wind?.deg,
          json.wind?.gust,
          getIconName(WeatherProvider.OPENWEATHERMAP, iconId, iconId[iconId.length - 1] === "n", true),
          getCondit(extension, json.weather[0].id, json.weather[0].description, gettext),
          sunrise,
          sunset,
          forecasts
        );
      }

    case WeatherProvider.WEATHERAPICOM:
      {
        params =
        {
          q: `${lat},${lon}`,
          days: String(extension._days_forecast + 2)
        };
        if(extension._providerTranslations) params.lang = extension.locale;
        let apiKey = extension.getWeatherKey();
        if(apiKey) params.key = apiKey;

        let response;
        try
        {
          response = await loadJsonAsync("https://api.weatherapi.com/v1/forecast.json", params);
        }
        catch(e)
        {
          console.error(`OpenWeather Refined: Failed to fetch weather from weatherapi.com ('${e.message}').`);
          return null;
        }

        let statusCode = response[0];
        let json = response[1];
        if(!isSuccess(statusCode))
        {
          let f;
          if(json && json.error) f = json.error.message;
          else f = `Status Code ${statusCode}`;
          console.error(`OpenWeather Refined: Invalid API Response from WeatherAPI.com '${f}'.`);

          if(statusCode === 403 && json?.error?.code === 2007) throw new TooManyReqError(WeatherProvider.WEATHERAPICOM);
          return null;
        }

        let m = json.current;
        let astro;
        try
        {
          astro = json.forecast.forecastday[0].astro;
        }
        catch(e)
        {
          console.log(m);
          console.log(json.forecast);
          console.log(json.forecast.forecastday);
          throw e;
        }

        const KPH_TO_MPS = 1.0 / 3.6;

        // Just a time is returned, we need to figure out if that time is
        // today or tomorrow
        let thisMorningMs = new Date().setHours(0, 0, 0, 0);
        let midnightMs = thisMorningMs + 3600000 * 24;
        let sunriseMs = timeToMs(astro.sunrise);
        let sunsetMs = timeToMs(astro.sunset);

        let sunrise, sunset;
        if(m.is_day)
        {
          sunrise = new Date(sunriseMs + midnightMs);
          sunset  = new Date(sunsetMs  + thisMorningMs);
        }
        else
        {
          sunrise = new Date(sunriseMs + thisMorningMs);
          sunset  = new Date(sunsetMs  + midnightMs);
        }

        let gotDaysForecast = json.forecast.forecastday.length;
        let forecastDays = clamp(1, extension._days_forecast + 1, gotDaysForecast);
        extension._forecastDays = forecastDays - 1;

        let forecasts = [ ];
        for(let i = 0; i < forecastDays; i++)
        {
          let day = [ ];
          let d = json.forecast.forecastday[i];
          for(let j = 0; j < d.hour.length; j++)
          {
            let h = d.hour[j];
            let dt = new Date(h.time);
            day.push(new Forecast(
              dt,
              new Date(dt.getTime() + 3600000),
              new Weather(
                h.temp_c,
                h.feelslike_c,
                h.humidity,
                h.pressure_mb,
                h.wind_kph * KPH_TO_MPS,
                h.wind_degree,
                h.gust_kph * KPH_TO_MPS,
                getIconName(WeatherProvider.WEATHERAPICOM, h.condition.code, !h.is_day, true),
                getCondit(extension, h.condition.code, h.condition.text, gettext),
                sunrise,
                sunset
              )
            ));
          }
          forecasts.push(day);
        }

        return new Weather(
          m.temp_c,
          m.feelslike_c,
          m.humidity,
          m.pressure_mb,
          m.wind_kph * KPH_TO_MPS,
          m.wind_degree,
          m.gust_kph * KPH_TO_MPS,
          getIconName(WeatherProvider.WEATHERAPICOM, m.condition.code, !m.is_day, true),
          getCondit(extension, m.condition.code, m.condition.text, gettext),
          sunrise,
          sunset,
          forecasts
        );
      }

    case WeatherProvider.VISUALCROSSING:
      {
        params =
        {
          unitGroup: "metric",
          contentType: "json",
          timezone: "Z",
          days: String(extension._days_forecast + 2)
        };
        if(extension._providerTranslations) params.lang = extension.locale;
        let apiKey = extension.getWeatherKey();
        if(apiKey) params.key = apiKey;

        let response;
        try
        {
          // %2C = "," (comma)
          response = await loadJsonAsync(`https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline/${lat}%2C${lon}`, params);
        }
        catch(e)
        {
          console.error(`OpenWeather Refined: Failed to fetch weather from visualcrossing.com ('${e.message}').`);
          return null;
        }

        const KPH_TO_MPS = 1.0 / 3.6;

        let statusCode = response[0];
        let json = response[1];
        if(!isSuccess(statusCode))
        {
          let f;
          if(json && json.error) f = json.error.message;
          else f = `Status Code ${statusCode}`;
          console.error(`OpenWeather Refined: Invalid API Response from VisualCrossing.com '${f}'.`);

          if(statusCode === 429) throw new TooManyReqError(WeatherProvider.VISUALCROSSING);
          return null;
        }

        let gotDaysForecast = json.days.length;
        let forecastDays = clamp(1, extension._days_forecast + 1, gotDaysForecast);
        extension._forecastDays = forecastDays - 1;

        let forecasts = [ ];
        for(let i = 0; i < forecastDays; i++)
        {
          let day = [ ];
          let d = json.days[i];
          for(let j = 0; j < d.hours.length; j++)
          {
            let h = d.hours[j];
            let dt = new Date(h.datetimeEpoch * 1000);
            let hSunriseDt = new Date(h.sunriseEpoch * 1000);
            let hSunsetDt = new Date(h.sunsetEpoch * 1000);
            day.push(new Forecast(
              dt,
              new Date(dt.getTime() + 3600000),
              new Weather(
                h.temp,
                h.feelslike,
                h.humidity,
                h.pressure,
                h.windspeed * KPH_TO_MPS,
                h.winddir,
                h.windgust * KPH_TO_MPS,
                // Only partly cloudy and clear have "-day" or "-night" at the end but those are
                // also the only icons with night variants
                getIconName(WeatherProvider.VISUALCROSSING, h.icon, !h.icon.endsWith("-night"), true),
                gettext(h.conditions),
                hSunriseDt,
                hSunsetDt
              )
            ));
          }
          forecasts.push(day);
        }

        let m = json.currentConditions;
        let sunriseDt = new Date(m.sunriseEpoch * 1000);
        let sunsetDt = new Date(m.sunsetEpoch * 1000);

        return new Weather(
          m.temp,
          m.feelslike,
          m.humidity,
          m.pressure,
          m.windspeed * KPH_TO_MPS,
          m.winddir,
          m.windgust * KPH_TO_MPS,
          // See comment in forecast
          getIconName(WeatherProvider.VISUALCROSSING, m.icon, !m.icon.endsWith("-night"), true),
          gettext(m.conditions),
          sunriseDt,
          sunsetDt,
          forecasts
        );
      }

    case WeatherProvider.QWEATHER:
      {
        let token = getQWeatherJwt();
        if(!token)
        {
          console.error("OpenWeather Refined: QWeather requires a valid JWT helper token.");
          return null;
        }
        let apiBase = getQWeatherApiBase();
        if(!apiBase)
        {
          console.error("OpenWeather Refined: QWeather requires QWEATHER_API_HOST in ~/.config/qweather/qweather.env.");
          return null;
        }

        params =
        {
          location: `${lon},${lat}`,
          lang: "zh",
          unit: "m"
        };
        const headers = {
          Authorization: `Bearer ${token}`
        };

        let response;
        let forecastResponse;
        try
        {
          let cur = loadJsonAsync(`${apiBase}/v7/weather/now`, params, headers, true);
          let fore = loadJsonAsync(`${apiBase}/v7/weather/3d`, params, headers, true);
          let allResp = await Promise.all([ cur, fore ]);
          response = allResp[0];
          forecastResponse = allResp[1];
        }
        catch(e)
        {
          console.error(`OpenWeather Refined: Failed to fetch weather from QWeather ('${e.message ?? e}').`);
          return null;
        }

        let json = response[1];
        let forecastJson = forecastResponse[1];
        if(!isSuccess(response[0]) || !isSuccess(forecastResponse[0]) ||
          json?.code !== "200" || forecastJson?.code !== "200")
        {
          console.error(`OpenWeather Refined: Invalid API Response from QWeather ` +
            `${response[0]}/${forecastResponse[0]}: '${json?.code}'/'${forecastJson?.code}'.`);
          if(json?.code === "402" || forecastJson?.code === "402") throw new TooManyReqError(WeatherProvider.QWEATHER);
          return null;
        }

        const KPH_TO_MPS = 1.0 / 3.6;
        let m = json.now;
        let today = forecastJson.daily?.[0] ?? {};
        let sunrise = parseQWeatherTime(today.sunrise);
        let sunset = parseQWeatherTime(today.sunset);
        let gotDaysForecast = forecastJson.daily?.length ?? 0;
        let forecastDays = clamp(1, extension._days_forecast + 1, gotDaysForecast);
        extension._forecastDays = forecastDays - 1;

        let forecasts = [];
        for(let i = 0; i < forecastDays; i++)
        {
          let d = forecastJson.daily[i];
          let day = [];
          let start = new Date(`${d.fxDate}T00:00:00`);
          let temp = (Number.parseFloat(d.tempMax) + Number.parseFloat(d.tempMin)) / 2;
          let feels = temp;
          let windMps = Number.parseFloat(d.windSpeedDay ?? 0) * KPH_TO_MPS;
          let pressure = Number.parseFloat(d.pressure ?? m.pressure ?? 0);
          let humidity = Number.parseFloat(d.humidity ?? m.humidity ?? 0);
          let icon = d.iconDay ?? m.icon;
          let text = d.textDay ?? m.text;
          let daySunrise = parseQWeatherTime(d.sunrise);
          let daySunset = parseQWeatherTime(d.sunset);

          for(let j = 0; j < 8; j++)
          {
            let dt = new Date(start.getTime() + j * 3 * 3600000);
            day.push(new Forecast(
              dt,
              new Date(dt.getTime() + 3 * 3600000),
              new Weather(
                temp,
                feels,
                humidity,
                pressure,
                windMps,
                Number.parseFloat(d.wind360Day ?? 0),
                undefined,
                qweatherIconName(icon),
                text,
                daySunrise,
                daySunset
              )
            ));
          }
          forecasts.push(day);
        }

        return new Weather(
          Number.parseFloat(m.temp),
          Number.parseFloat(m.feelsLike ?? m.temp),
          Number.parseFloat(m.humidity),
          Number.parseFloat(m.pressure),
          Number.parseFloat(m.windSpeed ?? 0) * KPH_TO_MPS,
          Number.parseFloat(m.wind360 ?? 0),
          undefined,
          qweatherIconName(m.icon),
          m.text,
          sunrise,
          sunset,
          forecasts
        );
      }

    case WeatherProvider.OPENMETEO:
      {
        params =
        {
          latitude: lat,
          longitude: lon,
          forecast_days: String(extension._days_forecast + 2),
          wind_speed_unit: "ms"
        };
        if(extension._providerTranslations) params.lang = extension.locale;
        let apiKey = extension.getWeatherKey();
        if(apiKey) params.key = apiKey;

        let response;
        try
        {
          response = await loadJsonAsync("https://api.weatherapi.com/v1/forecast.json", params);
        }
        catch(e)
        {
          console.error(`OpenWeather Refined: Failed to fetch weather from weatherapi.com ('${e.message}').`);
          return null;
        }
      }

    default:
      console.error("OpenWeather Refined: Invalid weather provider.");
      return null;
  }
}
