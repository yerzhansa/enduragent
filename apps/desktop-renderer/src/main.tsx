import "./theme/application.css";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { bootRenderer, type Disposer } from "./boot";
import { bootTheme, useEnduragentStore } from "./state/store";

bootTheme();

const disposeOpenSettings = window.enduragentAuth.onOpenSettings(() => {
  useEnduragentStore.getState().setActiveView("settings");
});
window.addEventListener("beforeunload", disposeOpenSettings, { once: true });

const container = document.querySelector("#root");
if (!(container instanceof HTMLElement)) {
  throw new TypeError("Desktop shell host is invalid: #root");
}

let runtime: Disposer | undefined;
let booting = false;

function onReady(): void {
  if (booting || runtime !== undefined) return;
  booting = true;
  queueMicrotask(() => {
    runtime = bootRenderer();
    useEnduragentStore.getState().markRuntimeReady();
  });
}

createRoot(container).render(<App onReady={onReady} />);
