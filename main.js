const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const WorkingRouteCollector = require("./index");

let collector = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  win.loadFile("index.html");

  // Перехват console.log для отправки в GUI
  const originalConsoleLog = console.log;
  console.log = (...args) => {
    win.webContents.send("log", args.join(" "));
    originalConsoleLog.apply(console, args);
  };

  console.error = (...args) => {
    win.webContents.send("log", `ERROR: ${args.join(" ")}`);
    originalConsoleLog.apply(console, args);
  };

  ipcMain.on("start-collection", async (event, city) => {
    if (!city || typeof city !== "string" || city.trim() === "") {
      console.error("Ошибка: город не указан или некорректен");
      return;
    }
    collector = new WorkingRouteCollector({
      headless: true,
      timeout: 90000,
      city: city.toLowerCase().trim(),
    });

    try {
      await collector.init();
      console.log(`Начинаем сбор маршрутов для ${city}`);
      await collector.performSearch("Маршруты автобусов");
      console.log(`Собрано маршрутов: ${collector.routeDetails.length}`);
    } catch (error) {
      console.error("Критическая ошибка:", error.message);
    } finally {
      await collector.close();
      console.log(`Сбор завершен`);
      collector = null;
    }
  });

  ipcMain.on("stop-collection", async () => {
    if (collector) {
      await collector.close();
      console.log(`Сбор остановлен`);
      collector = null;
    }
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
