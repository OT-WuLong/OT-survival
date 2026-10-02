import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const flagsScript = readFileSync(new URL(
  "../pack/ot_survival_status/ot_survival_behavior/scripts/status_flags.js", import.meta.url), "utf8")
  .replace(/^import \{[^\n]+\} from "@minecraft\/server";\s*/, "")
  .replace(/^export /gm, "");
const script = readFileSync(new URL(
  "../pack/ot_survival_status/ot_survival_behavior/scripts/sanity/index.js", import.meta.url), "utf8")
  .replace(/^import \{[^\n]+\} from "@minecraft\/server";\s*/, "")
  .replace(/^import \{[^\n]+\} from "\.\.\/status_flags\.js";\s*/, "")
  .replace(/^export /gm, "");

const compatScript = readFileSync(new URL(
  "../pack/ot_survival_status_compat/ot_survival_behavior_compat/scripts/sanity/index.js", import.meta.url), "utf8")
  .replace(/^import [^\n]+\n/gm, "").replace(/^export /gm, "");

function harness(legacyScore, implementation = script) {
  let onTick, onHurt, onCommand, onSpawn, onLeave;
  let time = 0;
  let light = 15;
  let hunger = 20;
  let objective;
  let flagsObjective;
  const effects = [];
  const sounds = [];
  const messages = [];
  const properties = new Map([["ot:temperature_tier", 2]]);
  const worldProperties = new Map();
  const scores = new Map();
  const jukeboxes = new Map();
  const searches = [];
  const warnings = [];
  const player = {
    id: "player-1", typeId: "minecraft:player", playerPermissionLevel: 2,
    mode: "survival", isSleeping: false, head: { x: 0, y: 65, z: 0 },
    getGameMode() { return this.mode; },
    getHeadLocation() { return { ...this.head }; },
    getComponent(id) { assert.equal(id, "minecraft:player.hunger"); return { currentValue: hunger }; },
    getDynamicProperty(key) { return properties.get(key); },
    setDynamicProperty(key, value) { properties.set(key, value); },
    addEffect(...args) { effects.push(args); },
    playSound(...args) { sounds.push(args); },
    sendMessage(message) { messages.push(message); },
    runCommand(command) {
      assert.match(command, /^scoreboard players set @s ot_sanity \d+$/);
      if (!objective) return { successCount: 0 };
      scores.set(this.id, Number(command.split(" ").at(-1)));
      return { successCount: 1 };
    },
    dimension: {
      id: "minecraft:overworld", heightRange: { min: -64, max: 320 },
      getLightLevel: () => light,
      getBlocks(volume, filter, allowUnloaded) {
        assert.deepEqual(Array.from(filter.includeTypes), ["minecraft:jukebox"]);
        assert.equal(allowUnloaded, true);
        assert.ok(volume.from.y >= this.heightRange.min && volume.to.y < this.heightRange.max);
        searches.push(volume);
        const locations = [...jukeboxes.values()].map((record) => record.location)
          .filter((loc) => ["x", "y", "z"].every((axis) => loc[axis] >= volume.from[axis] && loc[axis] <= volume.to[axis]));
        return { getBlockLocationIterator: () => locations.values() };
      },
      getBlock(loc) {
        const record = jukeboxes.get(`${loc.x},${loc.y},${loc.z}`);
        if (record?.unavailable) throw new Error("LocationInUnloadedChunkError");
        return record ? { typeId: "minecraft:jukebox", getComponent(id) {
          assert.equal(id, "minecraft:record_player");
          return { isPlaying: () => record.playing };
        } } : undefined;
      }
    }
  };
  const signal = (save) => ({ subscribe: save });
  const system = {
    currentTick: 0,
    runInterval(callback, interval) { assert.equal(interval, 1); onTick = callback; },
    run(callback) { callback(); },
    afterEvents: { scriptEventReceive: signal((callback) => { onCommand = callback; }) }
  };
  const world = {
    getDynamicProperty: (key) => worldProperties.get(key),
    setDynamicProperty: (key, value) => worldProperties.set(key, value),
    getAbsoluteTime: () => time,
    getAllPlayers: () => [player],
    scoreboard: {
      getObjective: (id) => id === "ot_status_flags" ? flagsObjective : objective,
      addObjective: (id) => {
        if (id === "ot_status_flags") {
          const flags = new Map();
          flagsObjective = { id, getScore: (participant) => flags.get(participant.id ?? participant),
            setScore: (participant, value) => flags.set(participant.id ?? participant, value) };
          return flagsObjective;
        }
        objective = { id, getScore: (participant) => scores.get(participant.id ?? participant) };
        return objective;
      }
    },
    afterEvents: {
      entityHurt: signal((callback) => { onHurt = callback; }),
      playerSpawn: signal((callback) => { onSpawn = callback; }),
      playerLeave: signal((callback) => { onLeave = callback; })
    }
  };
  const sandbox = {
    BlockVolume: class { constructor(from, to) { this.from = { ...from }; this.to = { ...to }; } },
    GameMode: { Survival: "survival", Adventure: "adventure" },
    PlayerPermissionLevel: { Operator: 2 }, system, world,
    Math: Object.assign(Object.create(Math), { random: () => 0 }),
    console: { warn: (message) => warnings.push(message) }
  };
  if (legacyScore !== undefined) {
    scores.set(player.id, legacyScore);
    objective = { id: "ot_sanity", getScore: (participant) => scores.get(participant.id ?? participant) };
  }
  runInNewContext(`${flagsScript}\n${implementation}\nglobalThis.api = { sanityEnabled, setSanityEnabled, pressure, stateFor };`, sandbox);
  return {
    player, properties, worldProperties, effects, sounds, messages, scores, jukeboxes, searches, warnings,
    sanityValue: () => sandbox.api.stateFor(player).value,
    jukebox(x, y, z, playing = true) { jukeboxes.set(`${x},${y},${z}`, { location: { x, y, z }, playing }); },
    tick(count = 1) { for (let i = 0; i < count; i++) { system.currentTick++; time++; onTick(); } },
    jumpTime(amount) { time += amount; },
    setLight(value) { light = value; },
    setHunger(value) { hunger = value; },
    hurt(damage, cause = "entityAttack") {
      onHurt({ hurtEntity: player, damage, damageSource: { cause } });
    },
    command(message) { onCommand({ id: "ot:sanity_test", message, sourceEntity: player }); },
    respawn() { onSpawn({ player, initialSpawn: false }); },
    leave() { onLeave({ playerId: player.id }); },
    disable() { sandbox.api.setSanityEnabled(false); },
    enable() { sandbox.api.setSanityEnabled(true); },
    removeObjective() { objective = undefined; scores.clear(); },
    get time() { return time; }
  };
}

for (const [edition, implementation] of [["full", script], ["compat", compatScript]]) {
test(`${edition}: actual jukebox playback adds two sanity per minute without stacking or replacing pressure`, () => {
  const scene = harness(undefined, implementation);
  scene.command("50");
  scene.jukebox(0, 64, 0);
  scene.jukebox(1, 64, 0);
  scene.tick(1200);
  assert.ok(Math.abs(scene.sanityValue() - 55) < 1e-9, "safe recovery three plus music two, not two per jukebox");
  assert.equal(scene.searches.length, 60, "search only at the one-second sanity update");
  for (const record of scene.jukeboxes.values()) record.playing = false;
  scene.tick(1200);
  assert.ok(Math.abs(scene.sanityValue() - 58) < 1e-9, "a record still in a stopped jukebox gives no music bonus");
  scene.jukebox(0, 64, 0);
  scene.setHunger(0);
  scene.properties.set("ot:temperature_tier", 0);
  scene.command("50");
  scene.tick(1200);
  assert.ok(Math.abs(scene.sanityValue() - 49) < 1e-9, "maximum ongoing pressure three minus music two still loses one");
  assert.deepEqual(scene.warnings, []);
});

test(`${edition}: music uses an eight-block 3D radius, handles stopped and unavailable sources and clips world height`, () => {
  const scene = harness(undefined, implementation);
  scene.player.head = { x: 0.5, y: 64.5, z: 0.5 };
  scene.command("50");
  scene.jukebox(8, 64, 0);
  scene.tick(20);
  assert.ok(Math.abs(scene.sanityValue() - (50 + 5 / 60)) < 1e-9, "exactly eight blocks is inside");
  scene.player.head.x = 0.49;
  scene.tick(20);
  assert.ok(Math.abs(scene.sanityValue() - (50 + 8 / 60)) < 1e-9, "just outside eight blocks only receives safe recovery");
  scene.jukebox(6, 70, 0);
  scene.tick(20);
  assert.ok(Math.abs(scene.sanityValue() - (50 + 11 / 60)) < 1e-9, "diagonally outside the sphere is excluded");
  scene.jukebox(0, 64, 0, false);
  scene.tick(20);
  assert.ok(Math.abs(scene.sanityValue() - (50 + 14 / 60)) < 1e-9, "empty or stopped machines do not count");
  scene.jukebox(0, 64, 0);
  scene.jukeboxes.get("0,64,0").unavailable = true;
  scene.jukebox(-1, 64, 0);
  scene.tick(20);
  assert.ok(Math.abs(scene.sanityValue() - (50 + 19 / 60)) < 1e-9, "an unreadable source does not hide another playing source");
  scene.player.head.y = 320.5;
  scene.jukebox(0, 319, 0);
  scene.tick(20);
  assert.ok(scene.searches.at(-1).to.y < 320, "never search above the build ceiling");
  const searched = scene.searches.length;
  scene.player.head.y = 400;
  scene.tick(20);
  assert.equal(scene.searches.length, searched, "skip a search region wholly outside world height");
  assert.deepEqual(scene.warnings, []);
});

test(`${edition}: music respects modes, the sanity switch, independent flags and the hundred-point cap`, () => {
  const scene = harness(undefined, implementation);
  scene.jukebox(0, 64, 0);
  scene.command("50");
  scene.disable();
  scene.tick(1200);
  assert.equal(scene.sanityValue(), 50);
  assert.equal(scene.searches.length, 0);
  scene.enable();
  scene.player.mode = "creative";
  scene.tick(1200);
  assert.equal(scene.sanityValue(), 50);
  assert.equal(scene.searches.length, 0);
  scene.player.mode = "survival";
  for (const name of ["stamina", "thirst", "temperature"]) scene.worldProperties.set(`ot:${name}_enabled`, false);
  scene.properties.set("ot:thirst_value", 0);
  scene.properties.set("ot:temperature_tier", 0);
  scene.tick(1200);
  assert.ok(Math.abs(scene.sanityValue() - 55) < 1e-9, "other systems' switches do not disable listening");
  scene.command("99");
  scene.tick(1200);
  assert.equal(scene.sanityValue(), 100);
  const searched = scene.searches.length;
  scene.tick(1200);
  assert.equal(scene.searches.length, searched, "no music search when full with no ongoing loss");
  scene.player.dimension.id = "minecraft:nether";
  scene.tick(1200);
  assert.equal(scene.sanityValue(), 100, "music can offset Nether pressure, even at a full initial value");
  assert.ok(scene.searches.length > searched, "full players under pressure must still be checked");
});
}

test("old world sanity score seeds the independent pack", () => {
  const scene = harness(68);
  scene.tick();
  assert.equal(scene.properties.get("ot:sanity_value"), 68);
});

test("sanity initializes at 100 and mirrors to a read-only scoreboard", () => {
  const scene = harness();
  scene.tick(20);
  assert.equal(scene.scores.get(scene.player.id), 100);
  assert.equal(scene.properties.get("ot:sanity_last_sleep"), 1);
  scene.command("60");
  scene.tick(20);
  assert.equal(scene.scores.get(scene.player.id), 60);
  scene.removeObjective();
  scene.tick(20);
  assert.equal(scene.scores.get(scene.player.id), 60);
});

test("Nether fear slowly drains sanity even with temperature disabled and bright shelter", () => {
  const scene = harness();
  scene.player.dimension.id = "minecraft:nether";
  scene.worldProperties.set("ot:temperature_enabled", false);
  scene.setLight(15);
  scene.tick(20);
  scene.command("80");
  scene.tick(2 * 1200);
  assert.equal(scene.scores.get(scene.player.id), 79);
  scene.disable();
  scene.tick(1200);
  assert.equal(scene.scores.get(scene.player.id), 79);
});

test("combined hunger, thirst, temperature, darkness and sleep loss is capped at 3 per minute", () => {
  const scene = harness();
  scene.tick(20);
  scene.command("80");
  scene.setHunger(0);
  scene.properties.set("ot:thirst_value", 0);
  scene.properties.set("ot:temperature_tier", 0);
  scene.setLight(0);
  scene.jumpTime(3 * 24000);
  scene.tick(1200);
  assert.ok(scene.scores.get(scene.player.id) >= 76 && scene.scores.get(scene.player.id) <= 77);
  assert.equal(scene.properties.get("ot:sanity_value"), scene.scores.get(scene.player.id));
  scene.setHunger(20);
  scene.properties.set("ot:thirst_value", 100);
  scene.properties.set("ot:temperature_tier", 2);
  scene.setLight(15);
  scene.player.isSleeping = true;
  scene.tick();
  scene.player.isSleeping = false;
  scene.tick(1200);
  assert.ok(scene.scores.get(scene.player.id) >= 98 && scene.scores.get(scene.player.id) <= 100,
    "睡眠补 20，安全环境再每分钟回 3");
});

test("dim light needs 30 seconds before it costs sanity and safe recovery is 3 per minute", () => {
  const scene = harness();
  scene.tick(20);
  scene.command("50");
  scene.setLight(4);
  scene.tick(29 * 20);
  assert.equal(scene.scores.get(scene.player.id), 50);
  scene.tick(60 * 20);
  assert.ok(scene.scores.get(scene.player.id) <= 48);
  scene.setLight(8);
  scene.tick(60 * 20);
  assert.ok(scene.scores.get(scene.player.id) >= 50);
});

test("injury loses at most 8 per hit and 12 per minute; thirst damage is excluded", () => {
  const scene = harness();
  scene.tick(20);
  scene.hurt(20);
  assert.equal(scene.properties.get("ot:sanity_value"), 92);
  scene.hurt(20);
  assert.equal(scene.properties.get("ot:sanity_value"), 88);
  scene.hurt(5);
  assert.equal(scene.properties.get("ot:sanity_value"), 88);
  scene.properties.set("ot:thirst_hurt_tick", 20);
  scene.hurt(1, "none");
  assert.equal(scene.properties.get("ot:sanity_value"), 88);
  scene.tick(1200);
  const before = scene.properties.get("ot:sanity_value");
  scene.hurt(3);
  assert.equal(scene.properties.get("ot:sanity_value"), before - 3);
});

test("panic speed triggers only on a downward crossing after full recovery and a day from trigger", () => {
  const scene = harness();
  scene.tick(20);
  scene.command("75");
  scene.command("74");
  assert.equal(scene.effects.filter(([id]) => id === "speed").length, 1);
  scene.command("100");
  scene.command("74");
  assert.equal(scene.effects.filter(([id]) => id === "speed").length, 1);
  scene.jumpTime(24000);
  scene.command("100");
  scene.command("74");
  assert.equal(scene.effects.filter(([id]) => id === "speed").length, 1,
    "跳过夜晚不能直接完成冷却");
  scene.tick(24000);
  scene.command("100");
  scene.command("74");
  assert.equal(scene.effects.filter(([id]) => id === "speed").length, 2);
});

test("panic cooldown and injury budget persist across rejoining", () => {
  const scene = harness();
  scene.tick(20);
  scene.command("75");
  scene.command("74");
  scene.hurt(20);
  scene.hurt(20);
  const saved = scene.properties.get("ot:sanity_value");
  scene.leave();
  scene.tick();
  scene.hurt(5);
  assert.equal(scene.properties.get("ot:sanity_value"), saved, "重连不能重置每分钟伤害额度");
  scene.command("100");
  scene.command("74");
  assert.equal(scene.effects.filter(([id]) => id === "speed").length, 1,
    "重连不能重置惊慌冷却");
});

test("weakness is intermittent; below 25 refreshes darkness and plays occasional cave audio", () => {
  const scene = harness();
  scene.tick(20);
  scene.command("24");
  scene.tick(20);
  assert.equal(scene.effects.filter(([id]) => id === "darkness").length, 1);
  assert.equal(scene.effects.filter(([id]) => id === "weakness").length, 0);
  scene.tick(45 * 20);
  assert.ok(scene.effects.some(([id]) => id === "weakness"));
  assert.ok(scene.sounds.some(([id]) => id === "ambient.cave"));
  scene.command("28");
  const darkCount = scene.effects.filter(([id]) => id === "darkness").length;
  scene.tick(100);
  assert.equal(scene.effects.filter(([id]) => id === "darkness").length, darkCount);
});

test("switch freezes all effects, creative debug is visual only, and death resets value", () => {
  const scene = harness();
  scene.tick(20);
  scene.command("24");
  scene.disable();
  const effectCount = scene.effects.length;
  scene.tick(60 * 20);
  assert.equal(scene.effects.length, effectCount);
  assert.equal(scene.properties.get("ot:sanity_value"), 24);
  scene.player.mode = "creative";
  scene.enable();
  scene.command("100");
  scene.command("24");
  assert.equal(scene.effects.length, effectCount);
  scene.respawn();
  scene.tick(20);
  assert.equal(scene.scores.get(scene.player.id), 100);
});
