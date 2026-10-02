import { ScriptEventSource, system } from "@minecraft/server";
import { setStaminaEnabled, setThirstEnabled } from "./stamina/index.js";
import { setTemperatureEnabled } from "./temperature/index.js";
import { setSanityEnabled } from "./sanity/index.js";

const setters = {
  stamina: setStaminaEnabled,
  thirst: setThirstEnabled,
  temperature: setTemperatureEnabled,
  sanity: setSanityEnabled
};

system.afterEvents.scriptEventReceive.subscribe((event) => {
  if (event.id !== "ot:status_toggle" || event.sourceType !== ScriptEventSource.Block) return;
  const [name, value, extra] = event.message.trim().split(/\s+/);
  if (!setters[name] || (value !== "on" && value !== "off") || extra) return;
  try { setters[name](value === "on"); }
  catch (error) { console.warn(`[status] 切换 ${name} 失败：${error}`); }
});
