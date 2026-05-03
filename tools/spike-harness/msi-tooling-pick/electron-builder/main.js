// Trivial Electron entry. The MSI tooling pick spike does not need a
// real UI — the comparison is about the installer toolchain, not the
// app code. Window opens, immediately quits.
const { app, BrowserWindow } = require("electron");

app.whenReady().then(() => {
  const w = new BrowserWindow({ width: 320, height: 200, show: false });
  w.loadURL("about:blank");
  app.quit();
});
