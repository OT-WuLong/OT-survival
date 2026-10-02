// Each slider changes this player's HUD only. UI applies a delta to a fixed base.
export const HUD_STEP = 1;
export const HUD_SLIDERS = [
  { key: "stamina_x", label: "体力条 左右（负数向左）", token: "A", limit: 100 },
  { key: "stamina_y", label: "体力条 上下（负数向上）", token: "B", limit: 75 },
  { key: "sanity_x", label: "理智条 左右（负数向左）", token: "C", limit: 100 },
  { key: "sanity_y", label: "理智条 上下（负数向上）", token: "D", limit: 75 },
  { key: "temperature_y", label: "温度 上下（负数向上）", token: "E", limit: 75 },
  { key: "thirst_y", label: "口渴 上下（负数向上）", token: "F", limit: 75 }
];

export function readHudPosition(player, slider) {
  const value = player.getDynamicProperty(`ot:hud_${slider.key}`);
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(-slider.limit, Math.min(slider.limit, Math.round(value / HUD_STEP) * HUD_STEP)) : 0;
}

export function saveHudPositions(player, values) {
  if (!Array.isArray(values) || values.length !== HUD_SLIDERS.length ||
      values.some((value, index) => typeof value !== "number" || !Number.isInteger(value) ||
        value % HUD_STEP !== 0 || Math.abs(value) > HUD_SLIDERS[index].limit)) {
    throw new Error("HUD 位置数据无效");
  }
  HUD_SLIDERS.forEach((slider, index) => {
    const value = values[index];
    player.setDynamicProperty(`ot:hud_${slider.key}`, value || undefined);
  });
}

export function hudPositionMarkers(player) {
  let markers = "";
  for (const slider of HUD_SLIDERS) {
    const value = readHudPosition(player, slider);
    if (value === 0) continue; // Zero adds no layout padding or compensation.
    if (value < 0) markers += `!${slider.token}.-|`;
    const magnitude = Math.abs(value);
    for (let bit = 0; 2 ** bit <= slider.limit; bit++) {
      if (magnitude & (2 ** bit)) markers += `!${slider.token}.${bit}|`;
    }
  }
  return markers;
}
