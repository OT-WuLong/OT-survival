import { readFileSync, writeFileSync } from "node:fs";

const files = [
  "../pack/ot_survival_status/ot_survival_resource/ui/hud_screen.json",
  "../pack/ot_survival_status_compat/ot_survival_resource_compat/ui/hud_screen.json"
];
const levels = 96;
const frameHeight = 50;
const ringSourceSize = 24;
const ringScale = 2 / 3;
const ringSize = ringSourceSize * ringScale;
const ringArcStart = Math.atan2(3.5, 11.5);
const ringArcEnd = 2 * Math.PI - ringArcStart;

function statusBar(kind, marker, texture) {
  const visible = [{
    binding_type: "view",
    source_control_name: "ot_position_data",
    source_property_name: `(not ((#preserved_text - '${marker}:') = #preserved_text))`,
    target_property_name: "#visible"
  }];
  return {
    type: "panel",
    size: [8, frameHeight],
    anchor_from: "bottom_middle",
    anchor_to: "bottom_middle",
    offset: [0, 0],
    allow_clipping: false,
    layer: 30,
    controls: [
      { [`ot_${kind}_empty`]: {
        type: "image", texture: "textures/ui/Black", color: [0.1, 0.1, 0.1], alpha: 0.75,
        size: [6, frameHeight - 2], anchor_from: "center", anchor_to: "center", layer: 5,
        bindings: visible
      } },
      { [`ot_${kind}_frame`]: {
        type: "image", texture: "textures/ui/stamina_frame", size: [8, frameHeight],
        bilinear: false, layer: 8, bindings: visible
      } },
      // One contiguous sprite per level avoids seams between source-pixel rows.
      ...Array.from({ length: levels }, (_, index) => {
        const level = index + 1;
        return { [`ot_${kind}_fill_${String(level).padStart(2, "0")}`]: {
          type: "image", texture, uv: [0, levels - level], uv_size: [12, level],
          size: [6, level / 2], anchor_from: "bottom_middle", anchor_to: "bottom_middle",
          offset: [0, -1], bilinear: false, layer: 7,
          bindings: [{
            binding_type: "view", source_control_name: "ot_position_data",
            source_property_name: `(not ((#preserved_text - '${marker}:${level}|') = #preserved_text))`,
            target_property_name: "#visible"
          }]
        } };
      })
    ]
  };
}

// Classic and pocket XP/locator bars all use this vanilla level-label template.
const progressTextLabel = {
  type: "label", shadow: true, text: "#level_number", color: [1, 1, 1],
  anchor_from: "top_middle", anchor_to: "top_middle", font_scale_factor: 0.5, layer: 11,
  bindings: [
    { binding_name: "#level_number", binding_type: "global" },
    { binding_name: "#level_number_visible", binding_type: "global",
      binding_name_override: "#visible" }
  ]
};

function ringParts(level) {
  // The source art is a round ring with a gap at 12 o'clock. Fill from its
  // left endpoint counterclockwise, so losing thirst clears from the right.
  const cutoff = ringArcEnd - (ringArcEnd - ringArcStart) * level / levels;
  const active = (x, y) => {
    if (level === levels) return true;
    const angle = (Math.atan2(x + 0.5 - 12, 12 - y - 0.5) + 2 * Math.PI) % (2 * Math.PI);
    return angle >= cutoff && angle <= ringArcEnd;
  };
  const rectangles = [];
  let previous = new Map();
  for (let y = 0; y < ringSourceSize; y++) {
    const current = new Map();
    for (let x = 0; x < ringSourceSize;) {
      if (!active(x, y)) { x++; continue; }
      const start = x;
      while (x < ringSourceSize && active(x, y)) x++;
      const width = x - start;
      const key = `${start}:${width}`;
      const rectangle = previous.get(key) ?? { x: start, y, width, height: 0 };
      rectangle.height++;
      if (!previous.has(key)) rectangles.push(rectangle);
      current.set(key, rectangle);
    }
    previous = current;
  }
  return rectangles.map(({ x, y, width, height }) => ({
    type: "image", texture: "textures/ui/temp_ring_full", uv: [x, y],
    uv_size: [width, height], size: [width * ringScale, height * ringScale],
    offset: [x * ringScale, y * ringScale],
    anchor_from: "top_left", anchor_to: "top_left", bilinear: false
  }));
}

const thermalVisible = (marker) => [{
  binding_type: "view", source_control_name: "ot_position_data",
  source_property_name: `(not ((#preserved_text - '${marker}') = #preserved_text))`,
  target_property_name: "#visible"
}];
const thirstRing = {
  type: "panel", size: [ringSize, ringSize], anchor_from: "bottom_middle", anchor_to: "bottom_middle",
  offset: [0, 0], allow_clipping: false, layer: 30,
  controls: [
    { ot_thirst_ring_empty: {
      type: "image", texture: "textures/ui/temp_ring_empty", size: [ringSize, ringSize],
      bilinear: false, layer: 5, bindings: thermalVisible("T:")
    } },
    ...Array.from({ length: levels }, (_, index) => {
      const level = index + 1;
      return { [`ot_thirst_ring_${String(level).padStart(2, "0")}`]: {
        type: "panel", size: [ringSize, ringSize], layer: 6,
        bindings: thermalVisible(`T:${level}|`),
        controls: ringParts(level).map((part, partIndex) => ({ [`part_${partIndex}`]: part }))
      } };
    })
  ]
};
const temperatureIcons = {
  ...thirstRing,
  controls: ["freezing", "cold", "normal", "hot", "scorching"].map((name, tier) => ({
    [`ot_temperature_${name}`]: {
      type: "image", texture: `textures/ui/temp_${name}`, size: [ringSize, ringSize],
      bilinear: false, layer: 7, bindings: thermalVisible(`C:${tier}|`)
    }
  }))
};
for (const file of files) {
  const path = new URL(file, import.meta.url);
  const ui = JSON.parse(readFileSync(path, "utf8"));
  ui.ot_stamina_probe = statusBar("stamina", "S", "textures/ui/stamina_fill");
  ui.ot_sanity_probe = statusBar("sanity", "M", "textures/ui/sanity_fill");
  ui.ot_thermal_probe = temperatureIcons;
  ui.ot_thirst_probe = thirstRing;
  ui.progress_text_label = progressTextLabel;
  ui["hud_title_text/title_frame"].bindings[1].source_property_name =
    "((#hud_title_text_string - 'OT_STATUS') = #hud_title_text_string)";
  writeFileSync(path, `${JSON.stringify(ui, null, 2)}\n`);
}
await import("../scripts/build_status_hud_positions.mjs");
