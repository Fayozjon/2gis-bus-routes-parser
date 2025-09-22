const puppeteer = require("puppeteer");
const fs = require("fs").promises;
const path = require("path");

class WorkingRouteCollector {
  constructor(options = {}) {
    this.browser = null;
    this.page = null;
    this.routeDetails = [];
    this.visitedPages = new Set();
    this.options = {
      headless: options.headless || true,
      timeout: options.timeout || 90000,
      city: options.city || "samarkand",
      ...options,
    };
    this.currentRouteSchedule = new Map();
  }

  async init() {
    try {
      this.browser = await puppeteer.launch({
        headless: this.options.headless,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-web-security",
        ],
      });

      this.page = await this.browser.newPage();

      await this.page.setUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      );
      await this.page.setViewport({ width: 1920, height: 1080 });

      await this.setupNetworkInterception();
    } catch (error) {
      console.error("Ошибка инициализации:", error.message);
      throw error;
    }
  }

  async setupNetworkInterception() {
    if (!this.page) {
      console.error(
        "Ошибка: this.page не определен в setupNetworkInterception"
      );
      return;
    }

    await this.page.setRequestInterception(true);

    this.page.on("request", (request) => {
      request.continue();
    });

    this.page.on("response", async (response) => {
      const url = response.url();
      const status = response.status();

      try {
        if (url.includes("byid") && status === 200) {
          const responseBody = await response.text();
          try {
            const byidData = JSON.parse(responseBody);

            if (
              byidData.result &&
              byidData.result.items &&
              byidData.result.items.length > 0
            ) {
              const routeItem = byidData.result.items[0];

              if (routeItem.type === "route") {
                const scheduleData =
                  this.currentRouteSchedule.get(routeItem.id) || {};
                await this.saveRouteToFile(routeItem, byidData, scheduleData);

                this.routeDetails.push({
                  id: routeItem.id,
                  url: url,
                  status: status,
                  routeData: routeItem,
                  fileName: this.getFileName(routeItem),
                  timestamp: new Date().toISOString(),
                });

                this.currentRouteSchedule.delete(routeItem.id);
              }
            }
          } catch (e) {
            console.error(`Ошибка парсинга byid:`, e.message);
          }
        } else if (
          url.includes("routing.api.2gis.com/ctx/search_schedule") &&
          status === 200
        ) {
          const responseBody = await response.text();
          try {
            const scheduleData = JSON.parse(responseBody);
            if (
              scheduleData.responses &&
              Array.isArray(scheduleData.responses)
            ) {
              const routeIdMatch = url.match(/routes\/(\d+)/);
              const routeId = routeIdMatch ? routeIdMatch[1] : null;

              if (routeId) {
                const schedules = scheduleData.responses
                  .filter(
                    (response) =>
                      response.status === "ok" && response.schedules?.length > 0
                  )
                  .map((response) => response.schedules[0])
                  .filter(
                    (schedule) =>
                      schedule.schedule?.type === "interval_trip" &&
                      schedule.schedule?.period &&
                      schedule.schedule?.work_hours
                  );

                if (schedules.length > 0) {
                  const firstSchedule = schedules[0].schedule;
                  const workHours = firstSchedule.work_hours;
                  const period = firstSchedule.period;

                  const startTime = new Date(workHours.start_time * 1000);
                  const finishTime = new Date(workHours.finish_time * 1000);
                  const hours = `${startTime
                    .getHours()
                    .toString()
                    .padStart(2, "0")}:${startTime
                    .getMinutes()
                    .toString()
                    .padStart(2, "0")}–${finishTime
                    .getHours()
                    .toString()
                    .padStart(2, "0")}:${finishTime
                    .getMinutes()
                    .toString()
                    .padStart(2, "0")}`;
                  const interval = `каждые ${period} минут`;

                  this.currentRouteSchedule.set(routeId, { interval, hours });
                }
              }
            }
          } catch (e) {
            console.error(`Ошибка парсинга schedule API:`, e.message);
          }
        }
      } catch (error) {
        console.error(`Ошибка обработки ответа ${url}:`, error.message);
      }
    });
  }

  getFileName(routeItem) {
    return `${routeItem.name || "unknown"}.json`;
  }

  async saveRouteToFile(routeItem, fullByidData, scheduleData = {}) {
    try {
      const routesDir = path.join(__dirname, "routes", this.options.city);
      await fs.mkdir(routesDir, { recursive: true });

      const fileName = this.getFileName(routeItem);
      const filePath = path.join(routesDir, fileName);

      const additionalInfo = await this.getRouteAdditionalInfo(routeItem);
      additionalInfo.interval =
        scheduleData.interval || additionalInfo.interval || null;
      additionalInfo.hours = scheduleData.hours || additionalInfo.hours || null;
      fullByidData.additional_info = additionalInfo;

      await fs.writeFile(
        filePath,
        JSON.stringify(fullByidData, null, 2),
        "utf8"
      );
      console.log(`Сохранен JSON: ${fileName}`);

      const geoJson = this.convert2GisToGeoJSON(fullByidData);
      const geoJsonFileName = fileName.replace(".json", ".geojson");
      const geoJsonFilePath = path.join(routesDir, geoJsonFileName);
      await fs.writeFile(
        geoJsonFilePath,
        JSON.stringify(geoJson, null, 2),
        "utf8"
      );
      console.log(`Сохранен GeoJSON: ${geoJsonFileName}`);
    } catch (error) {
      console.error("Ошибка сохранения файла маршрута:", error.message);
    }
  }

  async getRouteAdditionalInfo(routeItem) {
    try {
      if (!this.page) {
        console.error(
          "Ошибка: this.page не определен в getRouteAdditionalInfo"
        );
        return {
          name: routeItem
            ? `${routeItem.name} - ${routeItem.from_name} → ${routeItem.to_name}`
            : null,
          route: routeItem
            ? `${routeItem.from_name} → ${routeItem.to_name}`
            : null,
          interval: null,
          hours: null,
        };
      }

      await this.page
        .waitForSelector(
          'h1, [class*="title"], [class*="route"], [class*="schedule"], [class*="timetable"]',
          { timeout: 20000 }
        )
        .catch(() => {
          console.log("Основной элемент страницы маршрута не найден");
        });

      await this.page.evaluate(() =>
        window.scrollTo(0, document.body.scrollHeight)
      );

      const info = await this.page.evaluate(() => {
        const selectors = {
          interval:
            '[class*="interval"], [class*="schedule"], [class*="frequency"], [class*="time"], [class*="period"], [data-testid*="interval"], [class*="periodicity"], [class*="timetable"] span, [class*="schedule"] div',
          hours:
            '[class*="hours"], [class*="schedule"], [class*="working-hours"], [class*="time"], [class*="worktime"], [data-testid*="hours"], [class*="work-hours"], [class*="timetable"] span, [class*="schedule"] div',
        };

        const getText = (selector) => {
          const elements = document.querySelectorAll(selector);
          for (const element of elements) {
            const text = element.textContent.trim();
            if (text && text.match(/кажд|минут|интервал|через/i)) return text;
          }
          return null;
        };

        const getHours = (selector) => {
          const elements = document.querySelectorAll(selector);
          for (const element of elements) {
            const text = element.textContent.trim();
            if (text && text.match(/\d{1,2}:\d{2}.*–.*\d{1,2}:\d{2}/))
              return text;
          }
          return null;
        };

        return {
          interval: getText(selectors.interval),
          hours: getHours(selectors.hours),
        };
      });

      const additionalInfo = {
        name: routeItem
          ? `${routeItem.name} - ${routeItem.from_name} → ${routeItem.to_name}`
          : null,
        route: routeItem
          ? `${routeItem.from_name} → ${routeItem.to_name}`
          : null,
        interval: info.interval,
        hours: info.hours,
      };

      return additionalInfo;
    } catch (error) {
      console.error(
        "Ошибка получения дополнительной информации из HTML:",
        error.message
      );
      return {
        name: routeItem
          ? `${routeItem.name} - ${routeItem.from_name} → ${routeItem.to_name}`
          : null,
        route: routeItem
          ? `${routeItem.from_name} → ${routeItem.to_name}`
          : null,
        interval: null,
        hours: null,
      };
    }
  }

  convert2GisToGeoJSON(apiResponse) {
    const features = [];

    if (!apiResponse.result?.items) {
      console.error("Нет данных items в ответе");
      return { type: "FeatureCollection", features: [] };
    }

    const route = apiResponse.result.items[0];

    route.directions?.forEach((direction) => {
      const directionName = direction.type === "forward" ? "Туда" : "Обратно";

      direction.platforms?.forEach((platform) => {
        const centroid = platform.geometry?.centroid;
        if (centroid && centroid.startsWith("POINT")) {
          const match = centroid.match(/POINT\(([^ ]+) ([^)]+)\)/);
          if (match) {
            const lon = parseFloat(match[1]);
            const lat = parseFloat(match[2]);
            features.push({
              type: "Feature",
              geometry: { type: "Point", coordinates: [lon, lat] },
              properties: {
                name: platform.name,
                station_id: platform.station_id,
                direction: directionName,
                type: "stop",
              },
            });
          }
        }
      });

      if (direction.geometry?.immersion) {
        direction.geometry.immersion.forEach((imm) => {
          if (imm.selection && imm.selection.startsWith("LINESTRING")) {
            const coords = this.parseWKT(imm.selection);
            if (coords.length > 0) {
              features.push({
                type: "Feature",
                geometry: { type: "LineString", coordinates: coords },
                properties: {
                  name: `${route.name} — маршрут`,
                  direction: directionName,
                  type: "route",
                },
              });
            }
          }
        });
      }
    });

    return {
      type: "FeatureCollection",
      features: features,
    };
  }

  parseWKT(wkt) {
    const match = wkt.match(/LINESTRING\((.+)\)/);
    if (!match) return [];
    try {
      return match[1].split(",").map((pair) => {
        const [lon, lat] = pair.trim().split(" ").map(Number);
        return [lon, lat];
      });
    } catch (error) {
      console.error("Ошибка парсинга WKT:", error);
      return [];
    }
  }

  async findSearchInput() {
    if (!this.page) {
      console.error("Ошибка: this.page не определен в findSearchInput");
      return null;
    }

    const selectors = [
      'input[placeholder*="Поиск"]',
      'input[type="search"]',
      'input[class*="search"]',
      '[data-testid*="search"]',
    ];

    for (const selector of selectors) {
      try {
        await this.page.waitForSelector(selector, { timeout: 20000 });
        const element = await this.page.$(selector);
        if (element) {
          return element;
        }
      } catch (e) {
        console.log(`${selector} не найден`);
      }
    }
    return null;
  }

  async performSearch(searchQuery) {
    try {
      if (!this.page) {
        console.error("Ошибка: this.page не определен в performSearch");
        return;
      }

      await this.page.goto(`https://2gis.uz/${this.options.city}`, {
        waitUntil: "networkidle2",
        timeout: this.options.timeout,
      });

      const searchInput = await this.findSearchInput();
      if (!searchInput) {
        console.error("Поисковая строка не найдена");
        return;
      }

      await searchInput.click();
      await this.page.keyboard.down("Control");
      await this.page.keyboard.press("A");
      await this.page.keyboard.up("Control");

      await searchInput.type(searchQuery, { delay: 100 });
      await this.page.keyboard.press("Enter");

      await this.page
        .waitForNavigation({
          waitUntil: "networkidle2",
          timeout: this.options.timeout,
        })
        .catch((e) => {
          console.error("Ошибка ожидания навигации после поиска:", e.message);
        });

      await this.clickOnRoutes();
    } catch (error) {
      console.error(`Ошибка при поиске "${searchQuery}":`, error);
    }
  }

  async clickOnRoutes() {
    try {
      if (!this.page) {
        console.error("Ошибка: this.page не определен в clickOnRoutes");
        return;
      }

      let currentPage = 1;
      let hasNextPage = true;

      while (hasNextPage) {
        const routeElements = await this.page.evaluate(() => {
          const selectors = [
            '[data-testid="search-result-item"]',
            ".search-results-item",
            ".minicard",
            ".search-result",
            '[class*="searchResult"]',
            '[class*="miniCard"]',
            'a[href*="route"]',
          ];

          const foundElements = [];

          for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            elements.forEach((el, index) => {
              const text = el.textContent || "";
              const href = el.href || "";

              if (
                text.includes("М") ||
                text.includes("Т") ||
                text.includes("автобус") ||
                href.includes("route") ||
                text.match(/^\d+$/)
              ) {
                foundElements.push({
                  selector: selector,
                  index: index,
                  text: text.trim().substring(0, 50),
                  href: href,
                });
              }
            });

            if (foundElements.length > 0) break;
          }

          return foundElements;
        });

        for (let i = 0; i < routeElements.length; i++) {
          const routeElement = routeElements[i];

          try {
            const byidPromise = this.page.waitForResponse(
              (response) =>
                response.url().includes("byid") && response.status() === 200,
              { timeout: this.options.timeout }
            );

            const schedulePromise = this.page
              .waitForResponse(
                (response) =>
                  response
                    .url()
                    .includes("routing.api.2gis.com/ctx/search_schedule") &&
                  response.status() === 200,
                { timeout: this.options.timeout }
              )
              .catch(() => {
                console.log("Расписание не загружено для этого маршрута");
              });

            const clickResult = await this.page.evaluate(
              (selector, index) => {
                const elements = document.querySelectorAll(selector);
                if (elements[index]) {
                  elements[index].click();
                  return true;
                }
                return false;
              },
              routeElement.selector,
              routeElement.index
            );

            if (clickResult) {
              for (let j = 0; j < 3; j++) {
                await this.page
                  .click(
                    '[class*="schedule"], [data-testid*="schedule"], [class*="timetable"], [href*="schedule"], [class*="working-hours"], [class*="time"]',
                    { timeout: 10000 }
                  )
                  .catch(() => {
                    console.log(
                      `Вкладка расписания не найдена (попытка ${j + 1})`
                    );
                  });
                await this.page.evaluate(() =>
                  window.scrollTo(0, document.body.scrollHeight)
                );
              }

              await this.page
                .waitForNavigation({
                  waitUntil: "networkidle2",
                  timeout: this.options.timeout,
                })
                .catch((e) => {
                  console.error(
                    "Ошибка ожидания навигации после клика:",
                    e.message
                  );
                });

              await Promise.all([
                byidPromise.catch((e) => {
                  console.error("Ошибка ожидания byid ответа:", e.message);
                }),
                schedulePromise,
              ]);

              const currentUrl = this.page.url();
              if (
                currentUrl.includes("route") ||
                !currentUrl.includes("search")
              ) {
                await this.page
                  .goBack({
                    waitUntil: "networkidle2",
                    timeout: this.options.timeout,
                  })
                  .catch((e) => {
                    console.error("Ошибка возврата назад:", e.message);
                  });
              }
            }
          } catch (error) {
            console.error(
              `Ошибка клика ${i + 1} на странице ${currentPage}:`,
              error.message
            );
          }
        }

        hasNextPage = await this.handlePagination();
        if (hasNextPage) {
          currentPage++;
        }
      }
    } catch (error) {
      console.error("Ошибка при клике по маршрутам:", error);
    }
  }

  async handlePagination() {
    try {
      if (!this.page) {
        console.error("Ошибка: this.page не определен в handlePagination");
        return false;
      }

      const paginationSelectors = [
        'a._1q8es29[href*="page"]',
        'a[href*="page"]',
        'a[href*="Page"]',
        '.pagination a[href*="page"]',
        '[class*="pagination"] a[href*="page"]',
        'a[data-testid*="page"]',
      ];

      const currentUrl = this.page.url();
      let currentPageNumber = 1;
      const pageMatch =
        currentUrl.match(/[?&]page=(\d+)/i) ||
        currentUrl.match(/\/page\/(\d+)/i);
      if (pageMatch) {
        currentPageNumber = parseInt(pageMatch[1], 10);
      }

      this.visitedPages.add(currentPageNumber);

      const pageLinks = await this.page.evaluate((selectors) => {
        const links = [];
        for (const selector of selectors) {
          const elements = document.querySelectorAll(selector);
          elements.forEach((el, index) => {
            const href = el.getAttribute("href") || "";
            const text = el.textContent.trim();
            if (
              !el.classList.contains("active") &&
              !el.hasAttribute("disabled") &&
              !el.classList.contains("disabled") &&
              el.getAttribute("aria-disabled") !== "true"
            ) {
              links.push({
                selector,
                index,
                href,
                text,
              });
            }
          });
          if (links.length > 0) break;
        }
        return links;
      }, paginationSelectors);

      if (pageLinks.length === 0) {
        return false;
      }

      let nextPageLink = null;
      for (const link of pageLinks) {
        const href = link.href;
        const pageNumMatch =
          href.match(/[?&]page=(\d+)/i) || href.match(/\/page\/(\d+)/i);
        if (pageNumMatch) {
          const pageNum = parseInt(pageNumMatch[1], 10);
          if (
            pageNum === currentPageNumber + 1 &&
            !this.visitedPages.has(pageNum)
          ) {
            nextPageLink = link;
            break;
          }
        }
      }

      if (!nextPageLink && pageLinks.length > 0) {
        nextPageLink = pageLinks.find((link) => {
          const pageNumMatch =
            link.href.match(/[?&]page=(\d+)/i) ||
            link.href.match(/\/page\/(\d+)/i);
          return (
            pageNumMatch &&
            parseInt(pageNumMatch[1], 10) > currentPageNumber &&
            !this.visitedPages.has(parseInt(pageNumMatch[1], 10))
          );
        });
      }

      if (nextPageLink) {
        await this.page.evaluate(
          (selector, index) => {
            const elements = document.querySelectorAll(selector);
            if (elements[index]) {
              elements[index].click();
            }
          },
          nextPageLink.selector,
          nextPageLink.index
        );

        await this.page
          .waitForNavigation({
            waitUntil: "networkidle2",
            timeout: this.options.timeout,
          })
          .catch((e) => {
            console.error("Ошибка навигации:", e.message);
          });
        return true;
      }

      return false;
    } catch (error) {
      console.error("Ошибка при обработке пагинации:", error);
      return false;
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      console.log("Браузер закрыт");
    }
  }
}

module.exports = WorkingRouteCollector;
