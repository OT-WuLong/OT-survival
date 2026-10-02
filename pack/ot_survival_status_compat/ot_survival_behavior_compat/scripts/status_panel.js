import { PlayerPermissionLevel, system, world } from "@minecraft/server";
import { ActionFormData, ModalFormData } from "@minecraft/server-ui";
import { statusEnabled, setStatusEnabled } from "./status_flags.js";
import { HUD_SLIDERS, HUD_STEP, readHudPosition, saveHudPositions } from "./hud_positions.js";

const SETTINGS = [
  ["stamina", "体力"],
  ["thirst", "口渴"],
  ["temperature", "温度"],
  ["sanity", "理智"]
];
const openForms = new Set();

function isPlayer(player) {
  return player?.typeId === "minecraft:player" && player.isValid !== false;
}

function isOperator(player) {
  return isPlayer(player) && player.playerPermissionLevel === PlayerPermissionLevel.Operator;
}

async function showPositions(player) {
  const form = new ModalFormData().title("状态条位置（仅自己）").submitButton("保存位置");
  for (const slider of HUD_SLIDERS) {
    form.slider(slider.label, -slider.limit, slider.limit,
      { valueStep: HUD_STEP, defaultValue: readHudPosition(player, slider) });
  }
  form.toggle("恢复默认位置（保存后生效）", { defaultValue: false });
  const response = await form.show(player);
  if (response.canceled || !isPlayer(player)) return;
  const values = response.formValues;
  if (!Array.isArray(values) || values.length !== HUD_SLIDERS.length + 1 ||
      typeof values[HUD_SLIDERS.length] !== "boolean") throw new Error("位置表单数据无效");
  saveHudPositions(player, values[HUD_SLIDERS.length]
    ? HUD_SLIDERS.map(() => 0) : values.slice(0, HUD_SLIDERS.length));
}

async function showSwitches(player) {
  if (!isOperator(player)) return;
  const original = SETTINGS.map(([name]) => statusEnabled(name));
  const form = new ModalFormData().title("状态条开关（全世界）").submitButton("保存设置");
  SETTINGS.forEach(([, label], index) => form.toggle(label, { defaultValue: original[index] }));
  const response = await form.show(player);
  if (response.canceled || !isOperator(player)) return;
  const values = response.formValues;
  if (!Array.isArray(values) || values.length !== SETTINGS.length ||
      values.some((value) => typeof value !== "boolean")) throw new Error("开关表单数据无效");
  SETTINGS.forEach(([name], index) => {
    if (values[index] !== original[index]) setStatusEnabled(name, values[index]);
  });
  player.sendMessage("§a生存状态设置已保存，对全世界玩家生效。§r");
}

async function openPanel(player) {
  try {
    if (!isPlayer(player)) return;
    if (isOperator(player)) {
      const menu = new ActionFormData().title("生存状态面板")
        .body("状态条开关：对全世界玩家生效。\n调整我的状态条位置：仅对自己生效。")
        .button("状态条开关")
        .button("调整我的状态条位置");
      const response = await menu.show(player);
      if (response.canceled || !isPlayer(player)) return;
      if (response.selection === 0) await showSwitches(player);
      else if (response.selection === 1) await showPositions(player);
    } else await showPositions(player);
  } catch (error) {
    console.warn(`[status_panel] 无法保存设置：${error}`);
    if (isPlayer(player)) player.sendMessage("§c状态条设置失败，请查看内容日志。§r");
  } finally {
    openForms.delete(player.id);
  }
}

function queueOpen(player) {
  if (!isPlayer(player) || openForms.has(player.id)) return;
  openForms.add(player.id);
  system.run(() => { void openPanel(player); });
}

system.beforeEvents.startup.subscribe((event) => {
  event.itemComponentRegistry.registerCustomComponent("ot:status_panel_open", {
    onUse: ({ source }) => queueOpen(source),
    onUseOn: ({ source }) => queueOpen(source)
  });
});

world.afterEvents.playerLeave.subscribe(({ playerId }) => openForms.delete(playerId));
