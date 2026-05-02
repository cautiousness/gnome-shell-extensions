/*
   This file is part of OpenWeather (gnome-shell-extension-openweather).

   OpenWeather is free software: you can redistribute it and/or modify it under the terms of
   the GNU General Public License as published by the Free Software Foundation, either
   version 3 of the License, or (at your option) any later version.

   OpenWeather is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
   without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
   See the GNU General Public License for more details.

   You should have received a copy of the GNU General Public License along with OpenWeather.
   If not, see <https://www.gnu.org/licenses/>.

   Copyright 2022 Jason Oickle
*/
import { gettext as _ } from "resource:///org/gnome/shell/extensions/extension.js";
import GLib from "gi://GLib";
import * as Main from "resource:///org/gnome/shell/ui/main.js";

import { getCachedLocInfo, getLocationInfo } from "./myloc.js";
import {
  getWeatherInfo,
  getQWeatherCurrentInfo,
  getWeatherProviderName,
  getWeatherProvider,
  weatherProviderNotWorking,
  WeatherProvider
} from "./getweather.js";

function toPanelCondition(text)
{
  const value = String(text ?? "").trim();
  if (!value) return "";

  const rules = [
    [/暴雪|Blizzard/i, "暴雪"],
    [/大雪/i, "大雪"],
    [/中雪/i, "中雪"],
    [/小雪|Snow Flurry|Snow Shower/i, "小雪"],
    [/雨夹雪|Sleet|Wintry Mix/i, "雨雪"],
    [/暴雨|Rainstorm|Downpour|Torrential Rain/i, "暴雨"],
    [/大雨|Heavy Rain/i, "大雨"],
    [/中雨|Moderate Rain/i, "中雨"],
    [/小雨|Light Rain|Drizzle/i, "小雨"],
    [/阵雨|Shower|Showers?/i, "阵雨"],
    [/雷暴|Thunderstorm/i, "雷暴"],
    [/雷|Thunder/i, "雷雨"],
    [/霾|Haze/i, "雾霾"],
    [/雾|Mist|Fog/i, "雾天"],
    [/沙|尘|Dust|Sand/i, "沙尘"],
    [/阴|Overcast/i, "阴天"],
    [/云|Cloud/i, "多云"],
    [/晴|Sunny|Clear/i, "晴天"],
    [/风|Wind/i, "大风"],
  ];

  for (const [pattern, label] of rules) {
    if (pattern.test(value)) return label;
  }

  return [...value].slice(0, 2).join("");
}

function yieldToMainLoop()
{
  return new Promise(resolve =>
  {
    GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () =>
    {
      resolve();
      return GLib.SOURCE_REMOVE;
    });
  });
}

function _copyForecasts(weather)
{
  if (!weather || !weather.hasForecast()) return null;

  let days = weather.forecastDayCount();
  let forecasts = [];
  for (let i = 0; i < days; i++)
  {
    let hours = weather.forecastHourCount(i);
    let day = [];
    for (let j = 0; j < hours; j++)
    {
      day.push(weather.forecastDayHour(i, j));
    }
    forecasts.push(day);
  }

  return forecasts;
}

function _mergeCurrentWithCachedForecast(currentWeather, cachedWeather)
{
  if (!currentWeather || !cachedWeather || !cachedWeather.hasForecast()) {
    return currentWeather;
  }

  try
  {
    let cachedForecasts = _copyForecasts(cachedWeather);
    if (!cachedForecasts || cachedForecasts.length === 0) return currentWeather;
    return currentWeather.withForecasts(
      cachedForecasts,
      cachedWeather.getSunriseDate(),
      cachedWeather.getSunsetDate()
    );
  }
  catch (e)
  {
    console.error(`OpenWeather Refined: Failed to merge cached forecast: ${e}`);
    return currentWeather;
  }
}

async function initWeatherData(refresh) {
  if (refresh) {
    this._lastRefresh = Date.now();
  }
  try {
    await this.refreshWeatherData().then(async () => {
      try 
      {
        if(this._city.isMyLoc())
        {
          await getLocationInfo(this.settings);
        }
        this._scheduleLayoutRecalc();

      } catch (e) {
        console.error(e);
      }
    });
  } catch (e) {
    console.error(e);
  }
}

async function reloadWeatherCache()
{
  try
  {
    await this.populateCurrentUI();
    if (!this._isForecastDisabled)
    {
      await this.populateTodaysUI();
      await this.populateForecastUI();
      this.recalcLayout();
    }
  }
  catch (e)
  {
    console.error(e);
  }
}

async function refreshWeatherData()
{
  if (this._refreshInProgress) {
    return;
  }

  this._refreshInProgress = true;
  try
  {
    const provider = getWeatherProvider(this.settings);
    if (provider === WeatherProvider.QWEATHER) {
      let qweather;
      try
      {
        qweather = await getQWeatherCurrentInfo(this, _);
      }
      catch(e)
      {
        if(e.name === "TooManyReqError")
        {
          let provName = getWeatherProviderName(e.provider);
          let tryAgain = weatherProviderNotWorking(this.settings);

          if(tryAgain)
          {
            this._provUrlButton.label = getWeatherProviderName(this.weatherProvider);
            this.reloadWeatherCurrent(1);
          }
          else
          {
            Main.notify(_("OpenWeather Refined Too Many Requests"),
              _("Provider %s has too many users. Try switching weather providers in settings.").format(provName));

            this.reloadWeatherCurrent(600);
          }

          return;
        }
        else throw e;
      }

      if(!qweather)
      {
        console.warn("OpenWeather Refined: getQWeatherCurrentInfo failed without an error.");
        this.reloadWeatherCurrent(600);
        return;
      }

      this.currentWeatherCache = _mergeCurrentWithCachedForecast(
        qweather.weather,
        this.currentWeatherCache
      );
      await this.populateCurrentUI();
      _scheduleQWeatherForecastRefresh.call(this, qweather.forecastPromise);
      this.reloadWeatherCurrent(this._refresh_interval_current);
      return;
    }

    let weather;
    try
    {
      weather = await getWeatherInfo(this, _);
    }
    catch(e)
    {
      if(e.name === "TooManyReqError")
      {
        let provName = getWeatherProviderName(e.provider);
        let tryAgain = weatherProviderNotWorking(this.settings);

        if(tryAgain)
        {
          this._provUrlButton.label = getWeatherProviderName(this.weatherProvider);
          this.reloadWeatherCurrent(1);
        }
        else
        {
          Main.notify(_("OpenWeather Refined Too Many Requests"),
            _("Provider %s has too many users. Try switching weather providers in settings.").format(provName));

          // Try reloading after 10 minutes
          this.reloadWeatherCurrent(600);
        }

        return;
      }
      else throw e;
    }

    if(!weather)
    {
      console.warn("OpenWeather Refined: getWeatherInfo failed without an error.");
      // Try reloading after 10 minutes
      this.reloadWeatherCurrent(600);
      return;
    }

    this.currentWeatherCache = weather;

    await this.populateCurrentUI();
    if (this.menu && this.menu.isOpen) {
      this._pendingDetailedWeatherRefresh = true;
    } else {
      this._pendingDetailedWeatherRefresh = false;
      _scheduleDetailedWeatherRefresh.call(this);
    }
    this.reloadWeatherCurrent(this._refresh_interval_current);
  }
  catch(e)
  {
    console.error(`OpenWeather Refined: ${e}`);
    console.log(e.stack);
  }
  finally
  {
    this._refreshInProgress = false;
    if (this._reloadButton) {
      this._reloadButton.reactive = true;
      this._reloadButton.can_focus = true;
      if (this._reloadButton.child) {
        this._reloadButton.child.icon_name = "view-refresh-symbolic";
      }
    }
  }
}

function _scheduleQWeatherForecastRefresh(forecastPromise)
{
  if (!forecastPromise) return;

  this._qweatherForecastSeq = (this._qweatherForecastSeq ?? 0) + 1;
  const seq = this._qweatherForecastSeq;

  forecastPromise.then(async (weather) =>
  {
    if (!weather || seq !== this._qweatherForecastSeq) return;

    this.currentWeatherCache = weather;
    await this.populateCurrentUI();
    this._pendingDetailedWeatherRefresh = false;
    _scheduleDetailedWeatherRefresh.call(this);
  }).catch((e) =>
  {
    console.error(e);
  });
}

function _cancelDetailedWeatherRefresh()
{
  if (this._detailedWeatherRefreshTimeout) {
    GLib.source_remove(this._detailedWeatherRefreshTimeout);
    this._detailedWeatherRefreshTimeout = null;
  }
}

function _scheduleDetailedWeatherRefresh()
{
  _cancelDetailedWeatherRefresh.call(this);
  this._pendingDetailedWeatherRefresh = false;
  this._detailedWeatherRefreshTimeout = GLib.timeout_add(
    GLib.PRIORITY_DEFAULT_IDLE,
    1,
    () => {
      this._detailedWeatherRefreshTimeout = null;
      (async () => {
        try {
          await this.populateTodaysUI();
          if (!this._isForecastDisabled) {
            await this.populateForecastUI();
          }
          this._scheduleLayoutRecalc();
        } catch (e) {
          console.error(e);
        }
      })();
      return GLib.SOURCE_REMOVE;
    }
  );
}

async function populateCurrentUI()
{
  try
  {
    /** @type {(Weather | null)} */
    let w = this.currentWeatherCache;
    if(!w) throw new Error("OpenWeather Refined: No weather cached.");

    let panelWeather = w.hasForecast() ? w.forecastHoursFromNow(0).weather() : w;

    let location = this._city.getName(_);
    if(this._city.isMyLoc())
    {
      let locObj = getCachedLocInfo();
      let cityName = locObj.city;
      if(cityName === "Unknown") cityName = _("Unknown");
      location += ` (${cityName})`;
    }

    let iconName = panelWeather.getIconName();
    this._currentWeatherIcon.set_gicon(this.getGIcon(iconName));
    this._weatherIcon.set_gicon(this.getGIcon(iconName));

    let sunrise = panelWeather.getSunriseDate();
    let sunset = panelWeather.getSunsetDate();
    let lastBuild = new Date();

    if (sunrise instanceof Date && sunset instanceof Date) {
      // Is sunset approaching before the sunrise?
      let ms = lastBuild.getTime();
      if(sunrise.getTime() - ms > sunset.getTime() - ms)
      {
        this.topBoxSunIcon.set_gicon(this.getGIcon("daytime-sunset-symbolic"));
        this.topBoxSunInfo.text = panelWeather.displaySunset(this);
      }
      else
      {
        this.topBoxSunIcon.set_gicon(this.getGIcon("daytime-sunrise-symbolic"));
        this.topBoxSunInfo.text = panelWeather.displaySunrise(this);
      }
    } else {
      this.topBoxSunIcon.set_gicon(this.getGIcon("daytime-sunrise-symbolic"));
      this.topBoxSunInfo.text = "-";
    }

    let weatherInfoC = "";
    let weatherInfoT = "";

    let condition = panelWeather.displayCondition();
    let panelCondition = toPanelCondition(condition);
    let temp = panelWeather.displayTemperature(this);

    if (this._comment_in_panel) weatherInfoC = panelCondition;
    if (this._text_in_panel) weatherInfoT = temp;

    this._weatherInfo.text =
      weatherInfoC +
      (weatherInfoC && weatherInfoT ? _(", ") : "") +
      weatherInfoT;

    await this.populateCurrentDetailsUI();
    return 0;
  }
  catch (e)
  {
    throw e;
  }
}

async function populateCurrentDetailsUI()
{
  try
  {
    /** @type {(Weather | null)} */
    let w = this.currentWeatherCache;
    if(!w) throw new Error("OpenWeather Refined: No weather cached.");

    let panelWeather = w.hasForecast() ? w.forecastHoursFromNow(0).weather() : w;

    let location = this._city.getName(_);
    if(this._city.isMyLoc())
    {
      let locObj = getCachedLocInfo();
      let cityName = locObj.city;
      if(cityName === "Unknown") cityName = _("Unknown");
      location += ` (${cityName})`;
    }

    let sunrise = panelWeather.getSunriseDate();
    let sunset = panelWeather.getSunsetDate();
    let lastBuild = new Date();

    this._currentWeatherSummary.text = panelWeather.displayCondition() + (", ") + panelWeather.displayTemperature(this);

    let locText;
    if (this._loc_len_current !== 0 &&
      location.length > this._loc_len_current)
    {
      locText = location.substring(0, this._loc_len_current - 3) + "...";
    }
    else
    {
      locText = location;
    }

    let feelsLikeText = w.displayFeelsLike(this);
    let humidityText = w.displayHumidity();
    let pressureText = w.displayPressure(this);
    let windText = w.displayWind(this);

    this._currentWeatherSunrise.text = w.displaySunrise(this);
    this._currentWeatherSunset.text = w.displaySunset(this);
    this._currentWeatherBuild.text = this.formatTime(lastBuild);

    if(this._currentWeatherLocation) this._currentWeatherLocation.text = locText;
    if(this._currentWeatherFeelsLike) this._currentWeatherFeelsLike.text = feelsLikeText;
    if(this._currentWeatherHumidity) this._currentWeatherHumidity.text = humidityText;
    if(this._currentWeatherPressure) this._currentWeatherPressure.text = pressureText;
    if(this._currentWeatherWind) this._currentWeatherWind.text = windText;
    if(this._currentWeatherWindGusts)
    {
      let available = w.gustsAvailable();
      this.setGustsPanelVisibility(available);
      if(available)
      {
        this._currentWeatherWindGusts.text = w.displayGusts(this);
      }
    }

    if(this._forecast.length > this._forecastDays)
    {
      this._forecast.splice(this._forecastDays, this._forecast.length - this._forecastDays);
      this.rebuildFutureWeatherUi(this._forecastDays);
    }

    return 0;
  }
  catch (e)
  {
    throw e;
  }
}

async function populateTodaysUI() {
  // Populate today's forecast UI
  let weather = this.currentWeatherCache;
  if(!weather) throw new Error("OpenWeather Refined: No weather cached.");
  if(!weather.hasForecast()) throw new Error("OpenWeather Refined: No forecast.");

  for (let i = 0; i < 4; i++)
  {
    let h = weather.forecastHoursFromNow(i * 3);
    let w = h.weather();

    let forecastTodayUi = this._todays_forecast[i];
    forecastTodayUi.Time.text = h.displayTime(this);
    forecastTodayUi.Icon.set_gicon(this.getGIcon(w.getIconName()));
    forecastTodayUi.Temperature.text = w.displayTemperature(this);
    forecastTodayUi.Summary.text = w.displayCondition();

    await yieldToMainLoop();
  }
  return 0;
}

async function populateForecastUI() {
  try {
    // Populate N day / 3 hour forecast UI
    let weather = this.currentWeatherCache;
    if(!weather) throw new Error("OpenWeather Refined: No weather cached.");
    if(!weather.hasForecast()) throw new Error("OpenWeather Refined: No forecast.");

    let hrsToMidnight = 24 - new Date().getHours();
    let dayCount = Math.min(this._days_forecast + 1, weather.forecastDayCount());
    for (let i = 0; i < dayCount - 1; i++)
    {
      let forecastUi = this._forecast[i];
      for (let j = 0; j < 8; j++)
      {
        let h = weather.forecastHoursFromNow(i * 24 + hrsToMidnight + j * 3);
        let w = h.weather();

        let forecastDate = h.getStart();
        if (j === 0)
        {
          let beginOfDay = new Date(new Date().setHours(0, 0, 0, 0));
          let dayLeft = Math.floor(
            (forecastDate.getTime() - beginOfDay.getTime()) / 86400000
          );

          if (dayLeft === 1) forecastUi.Day.text = "\n" + _("Tomorrow");
          else
            forecastUi.Day.text =
              "\n" + this.getLocaleDay(forecastDate.getDay());
        }

        forecastUi[j].Time.text = h.displayTime(this);
        forecastUi[j].Icon.set_gicon(this.getGIcon(w.getIconName()));
        forecastUi[j].Temperature.text = w.displayTemperature(this);
        forecastUi[j].Summary.text = w.displayCondition();

        if ((i * 8 + j) % 4 === 3) {
          await yieldToMainLoop();
        }
      }
    }
    return 0;
  }
  catch (e)
  {
    throw e;
  }
}

function processTodaysData(json) {
  return new Promise((resolve, reject) => {
    try {
      let data = json.list;
      let todayList = [];

      for (let i = 0; i < 4; i++) todayList.push(data[i]);

      resolve(todayList);
    } catch (e) {
      reject(e);
    }
  });
}

export {
  initWeatherData,
  reloadWeatherCache,
  refreshWeatherData,
  _scheduleDetailedWeatherRefresh,
  populateCurrentUI,
  populateCurrentDetailsUI,
  populateTodaysUI,
  populateForecastUI,
};
