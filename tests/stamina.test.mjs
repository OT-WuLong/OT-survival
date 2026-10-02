import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";

const flagsScript = readFileSync(new URL(
  "../pack/ot_survival_status/ot_survival_behavior/scripts/status_flags.js", import.meta.url), "utf8")
  .replace(/^import \{[^\n]+\} from "@minecraft\/server";\s*/, "")
  .replace(/^export /gm, "");
const positionsScript = readFileSync(new URL(
  "../pack/ot_survival_status/ot_survival_behavior/scripts/hud_positions.js", import.meta.url), "utf8")
  .replace(/^export /gm, "");
const script = readFileSync(new URL(
  "../pack/ot_survival_status/ot_survival_behavior/scripts/stamina/index.js", import.meta.url), "utf8")
  .replace(/^import \{[^\n]+\} from "@minecraft\/server";\s*/, "")
  .replace(/^import \{[^\n]+\} from "\.\.\/status_flags\.js";\s*/, "")
  .replace(/^import \{[^\n]+\} from "\.\.\/hud_positions\.js";\s*/, "")
  .replace(/^export /gm, "");
const compatScript = readFileSync(new URL(
  "../pack/ot_survival_status_compat/ot_survival_behavior_compat/scripts/stamina/index.js", import.meta.url), "utf8")
  .replace(/^import [^\n]+\n/gm, "").replace(/^export /gm, "");
const ui = JSON.parse(readFileSync(new URL(
  "../pack/ot_survival_status/ot_survival_resource/ui/hud_screen.json", import.meta.url), "utf8"));
const levelCount = 96;
const namedControl = (controls, name) => controls.find((entry) => entry[name])?.[name];

function imageSize(path) {
  const png = readFileSync(new URL(
    `../pack/ot_survival_status/ot_survival_resource/textures/ui/${path}`, import.meta.url));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

function harness(mode = "survival", legacyScores = {}, implementation = script) {
  let onCommand;
  let onTick;
  let onLeave;
  let onSpawn;
  let onDrink;
  let onSwing, onHit, onHurt, onMineStart, onMineCancel, onMineBreak;
  let onBowStart, onBowStop, onBowRelease, onSlotChange;
  let beforeBreak, beforeHurt, beforeUse;
  const titles = [];
  const effects = [];
  const properties = new Map();
  const worldProperties = new Map();
  worldProperties.set("ot:temperature_enabled", false); // Existing meter tests isolate the future module.
  worldProperties.set("ot:sanity_enabled", false);
  const objectives = new Map();
  const commands = [];
  const permissions = { jump: true, changes: [] };
  const equipment = new Map();
  const player = {
    id: "player-1",
    typeId: "minecraft:player",
    playerPermissionLevel: 2,
    mode,
    isOnGround: true,
    isJumping: false,
    isSprinting: false,
    isSwimming: false,
    isInWater: false,
    isGliding: false,
    isSneaking: false,
    headBlockType: "minecraft:air",
    mineBlockType: "minecraft:stone",
    health: 20,
    hunger: 20,
    biomeId: "minecraft:plains",
    biomeQueries: 0,
    armorQueries: 0,
    velocity: { x: 0, y: 0, z: 0 },
    getGameMode() { return this.mode; },
    getVelocity() { return this.velocity; },
    getHeadLocation() { return { x: 0, y: 2, z: 0 }; },
    getComponent(id) {
      if (id === "minecraft:player.hunger") return { currentValue: this.hunger };
      if (id === "minecraft:equippable") return { getEquipment(slot) {
        player.armorQueries++;
        return equipment.get(slot);
      } };
      return undefined;
    },
    dimension: { id: "minecraft:overworld",
      heightRange: { min: -64, max: 320 },
      getBiome(location) {
        player.biomeQueries++;
        assert.ok(location.y >= this.heightRange.min && location.y < this.heightRange.max);
        return { id: player.biomeId };
      },
      getTopmostBlock() { return { location: { y: player.roofed ? 3 : 1 } }; },
      getBlock(location) {
      return { typeId: location.x === 1 ? player.mineBlockType : player.headBlockType };
    } },
    getDynamicProperty(key) { return properties.get(key); },
    setDynamicProperty(key, value) { properties.set(key, value); },
    inputPermissions: {
      isPermissionCategoryEnabled: () => permissions.jump,
      setPermissionCategory(category, enabled) {
        assert.equal(category, "Jump");
        permissions.jump = enabled;
        permissions.changes.push(enabled);
      }
    },
    onScreenDisplay: { setTitle: (title, options) => titles.push({ title, options }) },
    addEffect: (...args) => effects.push(args),
    applyDamage(amount) { this.health -= amount; return true; },
    runCommand(command) {
      const match = /^scoreboard players set @s (ot_stamina|ot_thirst) (\d+)$/.exec(command);
      assert.ok(match, command);
      const objective = objectives.get(match[1]);
      if (!objective) return { successCount: 0 };
      objective.scores.set(this.id, Number(match[2]));
      commands.push(command);
      return { successCount: 1 };
    },
    sendMessage() {}
  };
  const signal = (save) => ({ subscribe: (callback) => save(callback) });
  const sandbox = {
    EquipmentSlot: { Head: "Head", Chest: "Chest", Legs: "Legs", Feet: "Feet" },
    GameMode: { Survival: "survival", Adventure: "adventure" },
    InputPermissionCategory: { Jump: "Jump" },
    PlayerPermissionLevel: { Operator: 2 },
    console: { warn() {} },
    system: {
      currentTick: 0,
      runInterval: (callback) => { onTick = callback; },
      run: (callback) => callback(),
      afterEvents: { scriptEventReceive: signal((callback) => { onCommand = callback; }) }
    },
    world: {
      beforeEvents: {
        playerBreakBlock: signal((callback) => { beforeBreak = callback; }),
        entityHurt: signal((callback) => { beforeHurt = callback; }),
        itemUse: signal((callback) => { beforeUse = callback; })
      },
      getAllPlayers: () => [player],
      getDynamicProperty: (key) => worldProperties.get(key),
      setDynamicProperty: (key, value) => worldProperties.set(key, value),
      scoreboard: {
        getObjective: (id) => objectives.get(id),
        addObjective(id, displayName) {
          const objective = { id, displayName, scores: new Map() };
          objective.getScore = (participant) => objective.scores.get(participant.id ?? participant);
          objective.setScore = (participant, value) =>
            objective.scores.set(participant.id ?? participant, value);
          objectives.set(id, objective);
          return objective;
        }
      },
      afterEvents: {
        itemCompleteUse: signal((callback) => { onDrink = callback; }),
        playerSwingStart: signal((callback) => { onSwing = callback; }),
        entityHitEntity: signal((callback) => { onHit = callback; }),
        entityHurt: signal((callback) => { onHurt = callback; }),
        playerStartBreakingBlock: signal((callback) => { onMineStart = callback; }),
        playerCancelBreakingBlock: signal((callback) => { onMineCancel = callback; }),
        playerBreakBlock: signal((callback) => { onMineBreak = callback; }),
        itemStartUse: signal((callback) => { onBowStart = callback; }),
        itemStopUse: signal((callback) => { onBowStop = callback; }),
        itemReleaseUse: signal((callback) => { onBowRelease = callback; }),
        playerHotbarSelectedSlotChange: signal((callback) => { onSlotChange = callback; }),
        playerLeave: signal((callback) => { onLeave = callback; }),
        playerSpawn: signal((callback) => { onSpawn = callback; })
      }
    }
  };
  for (const [id, score] of Object.entries(legacyScores))
    sandbox.world.scoreboard.addObjective(id, id).setScore(player, score);
  runInNewContext(`${flagsScript}\n${positionsScript}\n${implementation}\nglobalThis.statusSwitches = { setStaminaEnabled, setThirstEnabled, stateFor };`, sandbox);
  return {
    player, properties, worldProperties, permissions, titles, effects, objectives, commands, equipment,
    setStaminaEnabled: sandbox.statusSwitches.setStaminaEnabled,
    setThirstEnabled: sandbox.statusSwitches.setThirstEnabled,
    staminaValue: () => sandbox.statusSwitches.stateFor(player).value,
    thirstValue: () => sandbox.statusSwitches.stateFor(player).thirst,
    command: (message, id = "ot:stamina_test") => onCommand({ id, message, sourceEntity: player }),
    drink: (typeId, potionEffectId = "minecraft:water") => onDrink({
      source: player,
      itemStack: { typeId, getComponent: () => ({ potionEffectType: { id: potionEffectId } }) }
    }),
    completeUse: (typeId) => onDrink({ source: player, itemStack: { typeId } }),
    tick: (count = 1) => { for (let i = 0; i < count; i++) { sandbox.system.currentTick++; onTick(); } },
    swing: () => onSwing({ player, swingSource: "Attack" }),
    hit: () => onHit({ damagingEntity: player, hitEntity: { id: "target-1", typeId: "minecraft:zombie" } }),
    meleeDamage: () => onHurt?.({ hurtEntity: { id: "target-1", typeId: "minecraft:zombie" }, damage: 2,
      damageSource: { cause: "entityAttack", damagingEntity: player } }),
    hurt: (cause) => onHurt?.({ hurtEntity: player, damageSource: { cause }, damage: 2 }),
    mineStart: () => onMineStart({ player, block: {
      dimension: player.dimension, location: { x: 1, y: 0, z: 0 }, typeId: player.mineBlockType
    } }),
    mineCancel: () => onMineCancel({ player, block: { location: { x: 1, y: 0, z: 0 } } }),
    mineBreak: () => onMineBreak({ player, block: { location: { x: 1, y: 0, z: 0 } } }),
    bowStart: (typeId = "minecraft:bow") => onBowStart({ source: player, itemStack: { typeId } }),
    bowStop: () => onBowStop({ source: player }),
    bowRelease: () => onBowRelease({ source: player }),
    slotChange: () => onSlotChange({ player }),
    tryBreak: () => { const event = { player, cancel: false }; beforeBreak(event); return event.cancel; },
    tryHurt: (cause = "entityAttack") => {
      const event = { damageSource: { cause, damagingEntity: player }, cancel: false };
      beforeHurt(event);
      return event.cancel;
    },
    tryProjectileOwner: () => {
      const projectile = { getComponent: () => ({ owner: player }) };
      const event = { damageSource: { cause: "projectile", damagingProjectile: projectile }, cancel: false };
      beforeHurt(event);
      return event.cancel;
    },
    tryUse: (typeId = "minecraft:bow") => {
      const event = { source: player, itemStack: { typeId }, cancel: false };
      beforeUse(event);
      return event.cancel;
    },
    leave: () => onLeave({ playerId: player.id }),
    respawn: () => onSpawn({ player, initialSpawn: false })
  };
}

for (const [edition, implementation] of [["full", script], ["compat", compatScript]]) {
test(`${edition}: armor material prices multiply sprint and swim without per-tick equipment scans`, () => {
  for (const [material, multiplier] of [["leather", 1], ["chainmail", 1.2], ["copper", 1.3],
    ["golden", 1.4], ["iron", 1.4], ["diamond", 1.3], ["netherite", 1.5]]) {
    for (const swimming of [false, true]) {
      const scene = harness("survival", {}, implementation);
      for (const [slot, part] of [["Head", "helmet"], ["Chest", "chestplate"], ["Legs", "leggings"], ["Feet", "boots"]])
        scene.equipment.set(slot, { typeId: `minecraft:${material}_${part}` });
      scene.command("50");
      scene.command("50", "ot:thirst_test");
      scene.player.isSprinting = true;
      scene.player.isSwimming = swimming;
      scene.tick(20);
      assert.ok(Math.abs(scene.staminaValue() - (50 - (swimming ? 4 : 3) * multiplier)) < 1e-9,
        `${material}, swimming ${swimming}`);
      assert.ok(Math.abs(scene.thirstValue() - (50 - 0.05 - (swimming ? 0.1 : 0.075) * multiplier)) < 1e-9);
      assert.equal(scene.player.armorQueries, 4, "only four equipment reads per second of exertion");
    }
  }
});

test(`${edition}: mixed worn armor adds once to sprinting jumps, not items in the inventory or offhand`, () => {
  const scene = harness("survival", {}, implementation);
  scene.equipment.set("Head", { typeId: "minecraft:iron_helmet" });
  scene.equipment.set("Chest", { typeId: "minecraft:elytra" });
  scene.equipment.set("Legs", { typeId: "minecraft:diamond_leggings" });
  scene.equipment.set("Feet", { typeId: "minecraft:netherite_boots" });
  scene.equipment.set("Offhand", { typeId: "minecraft:netherite_chestplate" });
  scene.equipment.set("Inventory", { typeId: "minecraft:netherite_helmet" });
  scene.tick();
  scene.command("50");
  scene.command("50", "ot:thirst_test");
  scene.player.isSprinting = true;
  scene.player.isOnGround = false;
  scene.player.isJumping = true;
  scene.player.velocity = { x: 0.1, y: 0.2, z: 0 };
  scene.tick();
  assert.ok(Math.abs(scene.staminaValue() - (50 - (0.15 + 2) * 1.3)) < 1e-9);
  assert.ok(Math.abs(scene.thirstValue() - (50 - 1 / 400 - (0.00375 + 0.05) * 1.3)) < 1e-9);
  scene.player.isSprinting = false;
  scene.tick();
  assert.ok(Math.abs(scene.staminaValue() - (50 - (0.15 + 2) * 1.3 + 0.2)) < 1e-9,
    "holding jump in the air does not pay a second jump");
  assert.equal(scene.player.armorQueries, 4);
});

test(`${edition}: armor does not reduce recovery or raise combat, mining or weapon-loading fees`, () => {
  for (const motion of ["rest", "walk", "water", "glide"]) {
    const scene = harness("survival", {}, implementation);
    for (const [slot, part] of [["Head", "helmet"], ["Chest", "chestplate"], ["Legs", "leggings"], ["Feet", "boots"]])
      scene.equipment.set(slot, { typeId: `minecraft:netherite_${part}` });
    scene.command("50");
    if (motion === "walk") scene.player.velocity.x = 0.1;
    if (motion === "water") scene.player.isInWater = true;
    if (motion === "glide") scene.player.isGliding = true;
    scene.tick(20);
    assert.ok(Math.abs(scene.staminaValue() - (motion === "rest" ? 58 : 54)) < 1e-9, motion);
    assert.equal(scene.player.armorQueries, 0, "recovery does not query load");
  }
  for (const action of ["hit", "bow", "crossbow", "break"]) {
    const scenes = [harness("survival", {}, implementation), harness("survival", {}, implementation)];
    for (const [slot, part] of [["Head", "helmet"], ["Chest", "chestplate"], ["Legs", "leggings"], ["Feet", "boots"]])
      scenes[1].equipment.set(slot, { typeId: `minecraft:netherite_${part}` });
    for (const scene of scenes) {
      scene.command("50");
      scene.command("50", "ot:thirst_test");
      if (action === "hit") scene.hit();
      else if (action === "break") scene.mineBreak();
      else scene.bowStart(`minecraft:${action}`);
      scene.tick(action === "hit" || action === "break" ? 2 : 20);
    }
    assert.ok(Math.abs(scenes[0].staminaValue() - scenes[1].staminaValue()) < 1e-9, action);
    assert.ok(Math.abs(scenes[0].thirstValue() - scenes[1].thirstValue()) < 1e-9, action);
  }
});

test(`${edition}: load refreshes on expiry and respawn while status switches and water keep their rules`, () => {
  const scene = harness("survival", {}, implementation);
  scene.equipment.set("Chest", { typeId: "minecraft:iron_chestplate" });
  scene.command("50");
  scene.command("50", "ot:thirst_test");
  scene.player.isSprinting = true;
  scene.setStaminaEnabled(false);
  scene.tick(20);
  assert.equal(scene.staminaValue(), 50);
  assert.ok(Math.abs(scene.thirstValue() - (50 - 0.05 - 0.075 * 1.1)) < 1e-9);
  scene.equipment.clear();
  scene.setStaminaEnabled(true);
  scene.setThirstEnabled(false);
  scene.tick(20);
  assert.ok(Math.abs(scene.staminaValue() - 47) < 1e-9, "equipment removal takes effect within one second");
  assert.equal(scene.player.armorQueries, 8);
  scene.equipment.set("Chest", { typeId: "minecraft:netherite_chestplate" });
  scene.respawn();
  scene.tick();
  assert.ok(Math.abs(scene.staminaValue() - (100 - 0.15 * 1.125)) < 1e-9, "respawn discards the old load sample");
  scene.player.isSprinting = false;
  scene.command("0");
  scene.tick(51);
  assert.ok(scene.staminaValue() >= 20);
  assert.equal(scene.permissions.jump, true, "heavy armor does not trap an exhausted resting player");
  scene.setThirstEnabled(true);
  scene.command("50", "ot:thirst_test");
  scene.player.isSwimming = true;
  scene.player.isInWater = true;
  scene.player.headBlockType = "minecraft:water";
  scene.tick(20);
  assert.ok(Math.abs(scene.thirstValue() - 51) < 1e-9, "freshwater still replaces activity thirst loss");
  scene.player.headBlockType = "minecraft:air";
  scene.player.isInWater = false;
  scene.player.isSwimming = false;
  scene.player.isSprinting = true;
  scene.worldProperties.set("ot:temperature_weather", "Rain");
  scene.command("50", "ot:thirst_test");
  scene.tick(20);
  assert.ok(Math.abs(scene.thirstValue() - 50.1) < 1e-9, "rain still replaces activity thirst loss");
});

test(`${edition}: hunger slows recovery only, multiplies cold and does not trap exhausted players`, () => {
  for (const [hunger, multiplier] of [[20, 1], [7, 1], [6, 0.75], [1, 0.75], [0, 0.5], [undefined, 1]]) {
    const scene = harness("survival", {}, implementation);
    scene.player.hunger = hunger;
    scene.command("50");
    scene.tick(20);
    assert.ok(Math.abs(scene.staminaValue() - (50 + 8 * multiplier)) < 1e-9, `rest, hunger ${hunger}`);
    scene.command("50");
    scene.player.velocity.x = 0.1;
    scene.properties.set("ot:stamina_recovery_multiplier", 0.5);
    scene.tick(20);
    assert.ok(Math.abs(scene.staminaValue() - (50 + 4 * 0.5 * multiplier)) < 1e-9, `walking in cold, hunger ${hunger}`);
    scene.command("50");
    scene.player.isSprinting = true;
    scene.tick(20);
    assert.ok(Math.abs(scene.staminaValue() - 47) < 1e-9, "hunger and cold do not multiply consumption");
    scene.setStaminaEnabled(false);
    scene.tick(20);
    assert.ok(Math.abs(scene.staminaValue() - 47) < 1e-9, "switch still freezes the mechanism");
  }
  const empty = harness("survival", {}, implementation);
  empty.player.hunger = 0;
  empty.command("0");
  assert.equal(empty.tryBreak(), true);
  empty.tick(101);
  assert.ok(empty.staminaValue() >= 20, "starving players still recover enough to escape exhaustion");
  assert.equal(empty.permissions.jump, true);
});

test(`${edition}: freshwater hydrates but every vanilla ocean family retains ordinary thirst loss`, () => {
  for (const biome of ["minecraft:ocean", "minecraft:deep_ocean", "minecraft:warm_ocean",
    "minecraft:deep_warm_ocean", "minecraft:lukewarm_ocean", "minecraft:deep_lukewarm_ocean",
    "minecraft:cold_ocean", "minecraft:deep_cold_ocean", "minecraft:frozen_ocean",
    "minecraft:deep_frozen_ocean", "minecraft:legacy_frozen_ocean"]) {
    const scene = harness("survival", {}, implementation);
    scene.player.biomeId = biome;
    scene.player.isInWater = true;
    scene.player.headBlockType = "minecraft:water";
    scene.command("50", "ot:thirst_test");
    scene.tick(20);
    assert.ok(Math.abs(scene.thirstValue() - 49.95) < 1e-9, biome);
    assert.equal(scene.player.biomeQueries, 1, "one biome sample per second, not per tick");
    scene.player.isSwimming = true;
    scene.setStaminaEnabled(false);
    scene.tick(20);
    assert.ok(Math.abs(scene.thirstValue() - 49.8) < 1e-9, `${biome}: swimming loss remains independent of stamina`);
    scene.drink("minecraft:potion");
    assert.ok(Math.abs(scene.thirstValue() - (49.8 + (edition === "full" ? 25 : 20))) < 1e-9,
      "bottled water keeps its established gain regardless of biome");
  }
  for (const [biome, block] of [["minecraft:river", "minecraft:water"],
    ["minecraft:frozen_river", "minecraft:flowing_water"], ["minecraft:plains", "minecraft:bubble_column"]]) {
    const scene = harness("survival", {}, implementation);
    scene.player.biomeId = biome;
    scene.player.isInWater = true;
    scene.player.headBlockType = block;
    scene.command("50", "ot:thirst_test");
    scene.tick(20);
    assert.ok(Math.abs(scene.thirstValue() - 51) < 1e-9, `${biome}: fresh ${block}`);
  }
});

test(`${edition}: water classification handles biome changes, dimensions, rain, unavailable cells and switches`, () => {
  const scene = harness("survival", {}, implementation);
  scene.player.biomeId = "minecraft:ocean";
  scene.player.isInWater = true;
  scene.player.headBlockType = "minecraft:water";
  scene.worldProperties.set("ot:temperature_weather", "Rain");
  scene.command("50", "ot:thirst_test");
  scene.tick(20);
  assert.ok(Math.abs(scene.thirstValue() - 49.95) < 1e-9, "rain above a submerged sea head does not grant water");
  scene.hit();
  assert.ok(Math.abs(scene.thirstValue() - 49.9) < 1e-9, "a submerged sea attack retains its instant fee, even when raining above");
  scene.player.biomeId = "minecraft:river";
  scene.tick();
  assert.ok(Math.abs(scene.thirstValue() - 49.95) < 1e-9, "biome classification refreshes within one second");
  scene.player.dimension.id = "minecraft:the_end";
  scene.player.biomeId = "minecraft:ocean";
  scene.tick();
  assert.ok(scene.thirstValue() < 49.95, "dimension changes invalidate a cached fresh classification immediately");
  scene.setThirstEnabled(false);
  const queries = scene.player.biomeQueries;
  const frozen = scene.thirstValue();
  scene.tick(30);
  assert.equal(scene.player.biomeQueries, queries);
  assert.equal(scene.thirstValue(), frozen);
  scene.setThirstEnabled(true);
  scene.player.dimension.getBiome = () => { throw new Error("LocationInUnloadedChunkError"); };
  scene.tick(20);
  assert.ok(scene.thirstValue() < frozen, "unreadable water never grants free hydration");
  scene.player.dimension.getBlock = () => { throw new Error("LocationOutOfWorldBoundariesError"); };
  scene.command("50");
  scene.tick(20);
  assert.ok(scene.staminaValue() > 50, "an invalid head cell does not stop stamina updates");
  const above = harness("survival", {}, implementation);
  above.player.isInWater = true;
  above.player.headBlockType = "minecraft:water";
  above.player.getHeadLocation = () => ({ x: 0, y: 332, z: 0 });
  above.command("50", "ot:thirst_test");
  above.tick();
  assert.equal(above.player.biomeQueries, 1, "biome sampling is clipped to dimension height");
});
}

test("status values mirror to command-readable scoreboards without idle writes", () => {
  const scene = harness("creative");
  scene.tick();
  assert.equal(scene.objectives.get("ot_stamina").scores.get(scene.player.id), 100);
  assert.equal(scene.objectives.get("ot_thirst").scores.get(scene.player.id), 100);
  assert.equal(scene.titles.length, 0);
  scene.tick(20);
  assert.equal(scene.commands.length, 2);

  scene.command("25");
  scene.command("40", "ot:thirst_test");
  scene.tick();
  assert.equal(scene.objectives.get("ot_stamina").scores.get(scene.player.id), 25);
  assert.equal(scene.objectives.get("ot_thirst").scores.get(scene.player.id), 40);

  scene.command("off");
  scene.command("off", "ot:thirst_test");
  scene.tick(20);
  assert.equal(scene.commands.length, 4);
  scene.objectives.delete("ot_thirst");
  scene.tick();
  assert.equal(scene.objectives.get("ot_thirst").scores.get(scene.player.id), 40);
});

test("status scores follow gameplay values, pause with switches, and reset after death", () => {
  const scene = harness();
  scene.tick();
  scene.player.isSprinting = true;
  scene.tick(20);
  assert.equal(scene.objectives.get("ot_stamina").scores.get(scene.player.id), 97);
  scene.command("0");
  scene.command("19", "ot:thirst_test");
  scene.tick();
  assert.equal(scene.objectives.get("ot_stamina").scores.get(scene.player.id), 0);
  assert.equal(scene.objectives.get("ot_thirst").scores.get(scene.player.id), 19);

  scene.setStaminaEnabled(false);
  scene.setThirstEnabled(false);
  scene.tick(20);
  assert.equal(scene.objectives.get("ot_stamina").scores.get(scene.player.id), 0);
  assert.equal(scene.objectives.get("ot_thirst").scores.get(scene.player.id), 19);
  scene.respawn();
  scene.tick();
  assert.equal(scene.objectives.get("ot_stamina").scores.get(scene.player.id), 100);
  assert.equal(scene.objectives.get("ot_thirst").scores.get(scene.player.id), 100);
});

test("old world stamina and thirst scores seed the new pack's player properties", () => {
  const scene = harness("survival", { ot_stamina: 41, ot_thirst: 63 });
  scene.tick();
  assert.equal(scene.properties.get("ot:stamina_value"), 41);
  assert.equal(scene.properties.get("ot:thirst_value"), 63);
});

test("stamina and 24px thermal HUD assets use pixel-aligned sizes", () => {
  assert.deepEqual(imageSize("stamina_frame.png"), [16, 100]);
  assert.deepEqual(imageSize("stamina_fill.png"), [12, 96]);
  assert.deepEqual(imageSize("sanity_fill.png"), [12, 96]);
  assert.ok(readFileSync(new URL("../assets/textures/sanity_fill.png", import.meta.url))
    .equals(readFileSync(new URL("../pack/ot_survival_status/ot_survival_resource/textures/ui/sanity_fill.png", import.meta.url))));
  for (const name of ["ring_empty", "ring_full", "freezing", "cold", "normal", "hot", "scorching"])
    assert.deepEqual(imageSize(`temp_${name}.png`), [24, 24]);
  for (const name of ["temp_ring_empty.png", "temp_ring_full.png"])
    assert.ok(readFileSync(new URL(`../assets/textures/${name}`, import.meta.url))
      .equals(readFileSync(new URL(`../pack/ot_survival_status/ot_survival_resource/textures/ui/${name}`, import.meta.url))));
  assert.equal(existsSync(new URL("../pack/ot_survival_status/ot_survival_resource/textures/ui/stamina_frame.json", import.meta.url)), false);
  const overlay = ui.ot_stamina_probe;
  assert.deepEqual(overlay.size, [8, 50]);
  assert.deepEqual(overlay.offset, [0, 0]);
  assert.deepEqual(ui.ot_thermal_probe.size, [16, 16]);
  assert.deepEqual(ui.ot_thermal_position["$ot_base_offset|default"], [0, -32]);
  assert.deepEqual(ui.ot_sanity_position["$ot_base_offset|default"], [95, -1]);
  assert.equal(overlay.controls.length, 98);
  assert.equal(ui.ot_thermal_probe.controls.length, 5);
  assert.equal(ui.ot_thirst_probe.controls.length, 97);
  assert.ok(overlay.controls.every((control) => !control.ot_stamina_label));
  assert.equal(namedControl(overlay.controls, "ot_stamina_frame").texture, "textures/ui/stamina_frame");
  assert.deepEqual(namedControl(overlay.controls, "ot_stamina_frame").size, [8, 50]);
  assert.deepEqual(namedControl(overlay.controls, "ot_stamina_empty").size, [6, 48]);
  assert.equal(namedControl(ui.ot_thirst_probe.controls, "ot_thirst_ring_empty").texture,
    "textures/ui/temp_ring_empty");
  assert.deepEqual(ui.root_panel.modifications[0].value.map((entry) => Object.keys(entry)[0]), [
    "ot_position_data@hud.ot_position_data",
    "ot_stamina_position@hud.ot_stamina_position", "ot_thirst_position@hud.ot_thirst_position",
    "ot_thermal_position@hud.ot_thermal_position", "ot_sanity_position@hud.ot_sanity_position"
  ]);
});

test("vertical bars stay on the proven HUD root and clear mobile hunger icons", () => {
  const compat = JSON.parse(readFileSync(new URL(
    "../pack/ot_survival_status_compat/ot_survival_resource_compat/ui/hud_screen.json", import.meta.url), "utf8"));
  for (const layout of [ui, compat]) {
    const root = layout.root_panel.modifications[0].value.map((entry) => Object.keys(entry)[0]);
    assert.ok(root.includes("ot_stamina_position@hud.ot_stamina_position"));
    assert.ok(root.includes("ot_sanity_position@hud.ot_sanity_position"));
    assert.equal(layout.hotbar_start_cap, undefined);
    assert.equal(layout.hotbar_end_cap, undefined);
    // Approximate the supplied mobile screenshot after its 2048px resize.
    const vertical = layout.ot_sanity_position.controls[0].layout;
    const horizontal = vertical.controls.find((entry) => entry.display_anchor).display_anchor.controls[0].horizontal;
    const mobilePadding = horizontal.controls.find((entry) => entry.mobile_padding).mobile_padding;
    const rightBarX = layout.ot_sanity_position["$ot_base_offset|default"][0] + mobilePadding.size[0] / 2;
    const rightBarLeft = 1024 + (rightBarX - 4) * 3.67;
    assert.ok(rightBarLeft > 1390, "理智条默认位置不应覆盖手机版饱食度末端");
  }
});

test("96 stamina levels use one continuous source-pixel region", () => {
  const controls = ui.ot_stamina_probe.controls;
  for (let level = 1; level <= levelCount; level++) {
    const fill = namedControl(controls, `ot_stamina_fill_${String(level).padStart(2, "0")}`);
    assert.equal(fill.texture, "textures/ui/stamina_fill");
    assert.deepEqual(fill.uv, [0, 96 - level]);
    assert.deepEqual(fill.uv_size, [12, level]);
    assert.deepEqual(fill.size, [6, level / 2]);
    assert.deepEqual(fill.offset, [0, -1]);
    assert.equal(fill.bindings[0].source_property_name,
      `(not ((#preserved_text - 'S:${level}|') = #preserved_text))`);
  }
});

test("sanity uses the matching right-hand 96-level bar and shared title marker", () => {
  const controls = ui.ot_sanity_probe.controls;
  assert.deepEqual(ui.ot_sanity_probe.size, [8, 50]);
  assert.equal(controls.length, 98);
  assert.equal(namedControl(controls, "ot_sanity_frame").texture, "textures/ui/stamina_frame");
  for (let level = 1; level <= levelCount; level++) {
    const fill = namedControl(controls, `ot_sanity_fill_${String(level).padStart(2, "0")}`);
    assert.equal(fill.texture, "textures/ui/sanity_fill");
    assert.deepEqual(fill.uv, [0, 96 - level]);
    assert.deepEqual(fill.uv_size, [12, level]);
    assert.equal(fill.bindings[0].source_property_name,
      `(not ((#preserved_text - 'M:${level}|') = #preserved_text))`);
  }
  const scene = harness();
  scene.worldProperties.delete("ot:sanity_enabled");
  scene.setStaminaEnabled(false);
  scene.setThirstEnabled(false);
  scene.tick();
  assert.equal(scene.titles.at(-1).title, "OT_STATUS|M:96|");
  scene.properties.set("ot:sanity_value", 25);
  scene.tick();
  assert.equal(scene.titles.at(-1).title, "OT_STATUS|M:92|");
  scene.worldProperties.set("ot:sanity_enabled", false);
  scene.tick();
  assert.equal(scene.titles.at(-1).title, "OT_STATUS_OFF");
});

test("saving a personal HUD offset changes only the player's HUD title markers", () => {
  const scene = harness();
  scene.tick();
  const before = scene.titles.at(-1).title;
  assert.ok(before.startsWith("OT_STATUS|S:"));
  scene.properties.set("ot:hud_stamina_x", -15);
  scene.properties.set("ot:hud_temperature_y", 10);
  scene.tick();
  const after = scene.titles.at(-1).title;
  assert.ok(after.includes("!A.1|"));
  assert.ok(after.includes("!E.3|"));
  assert.equal(after.replace(/![AE]\.[\d-]\|/g, ""), before);
});

test("96 thirst levels crop the circular 24px ring without UV overlap", () => {
  const controls = ui.ot_thirst_probe.controls;
  let previousCount = 0;
  const frameSizes = new Set();
  for (let level = 1; level <= levelCount; level++) {
    const ring = namedControl(controls, `ot_thirst_ring_${String(level).padStart(2, "0")}`);
    assert.equal(ring.bindings[0].source_property_name,
      `(not ((#preserved_text - 'T:${level}|') = #preserved_text))`);
    const pixels = new Set();
    for (const partEntry of ring.controls) {
      const part = Object.values(partEntry)[0];
      assert.equal(part.texture, "textures/ui/temp_ring_full");
      assert.deepEqual(part.offset, part.uv.map((value) => value * (2 / 3)));
      assert.deepEqual(part.size, part.uv_size.map((value) => value * (2 / 3)));
      const [x, y] = part.uv;
      const [width, height] = part.uv_size;
      assert.ok(x >= 0 && y >= 0 && x + width <= 24 && y + height <= 24);
      for (let py = y; py < y + height; py++) for (let px = x; px < x + width; px++) {
        const key = `${px},${py}`;
        assert.ok(!pixels.has(key), "环形进度不能重叠");
        pixels.add(key);
      }
    }
    assert.ok(pixels.size >= previousCount, `口渴 ${level} 档不应倒退`);
    previousCount = pixels.size;
    frameSizes.add(pixels.size);
    if (level === 96) assert.equal(pixels.size, 24 * 24);
  }
  assert.ok(frameSizes.size >= 90, "24×24 圆环应保留九十余种视觉过渡");
  for (const [index, name] of ["freezing", "cold", "normal", "hot", "scorching"].entries()) {
    const icon = namedControl(ui.ot_thermal_probe.controls, `ot_temperature_${name}`);
    assert.equal(icon.texture, `textures/ui/temp_${name}`);
    assert.equal(icon.bindings[0].source_property_name,
      `(not ((#preserved_text - 'C:${index}|') = #preserved_text))`);
  }
});

test("thermal HUD uses a compact centered footprint instead of crowding hearts and hunger", () => {
  const gauge = ui.ot_thermal_probe;
  const ring = ui.ot_thirst_probe;
  assert.deepEqual(gauge.size, [16, 16]);
  assert.equal(ui.ot_thermal_position["$ot_base_offset|default"][1], -32);
  assert.deepEqual(namedControl(ring.controls, "ot_thirst_ring_empty").size, [16, 16]);
  for (const iconEntry of gauge.controls.slice(-5))
    assert.deepEqual(Object.values(iconEntry)[0].size, [16, 16]);
  for (const ringEntry of ring.controls.slice(1)) {
    const fill = Object.values(ringEntry)[0];
    assert.deepEqual(fill.size, [16, 16]);
    for (const partEntry of fill.controls) {
      const part = Object.values(partEntry)[0];
      assert.deepEqual(part.size, part.uv_size.map((value) => value * (2 / 3)));
      assert.deepEqual(part.offset, part.uv.map((value) => value * (2 / 3)));
    }
  }
});

test("thermal HUD clears the experience bar without rising above armor and air", () => {
  const gauge = ui.ot_thermal_probe;
  // Calibrated from the in-game screenshot at 4 screen pixels per HUD unit:
  // the old 18-unit panel ended at y=144, while XP starts at y=129.
  const position = ui.ot_thermal_position["$ot_base_offset|default"];
  const bottom = 144 + (position[1] + 27) * 4;
  const top = bottom - gauge.size[1] * 4;
  assert.equal(position[0], 0);
  assert.ok(gauge.size[0] <= 16, "center gauge should be visibly smaller");
  assert.ok(bottom <= 125, `gauge bottom ${bottom} must clear XP with a small gap`);
  assert.ok(top >= 43, `gauge top ${top} should not overtop armor/air at y=47`);
  assert.ok(top <= 65, `gauge top ${top} should sit near armor/air, not down by XP`);
});

test("vanilla XP level sits inside the bar without losing its bindings", () => {
  const label = ui.progress_text_label;
  assert.equal(label.type, "label");
  assert.equal(label.text, "#level_number");
  assert.equal(label.anchor_from, "top_middle");
  assert.equal(label.anchor_to, "top_middle");
  assert.equal(label.font_scale_factor, 0.5);
  assert.equal(label.layer, 11);
  assert.deepEqual(label.color, [1, 1, 1]);
  assert.equal(label.shadow, true);
  assert.deepEqual(label.bindings, [
    { binding_name: "#level_number", binding_type: "global" },
    { binding_name: "#level_number_visible", binding_type: "global",
      binding_name_override: "#visible" }
  ]);
});

test("circular thirst depletion clears clockwise from the top-right gap", () => {
  const ring = ui.ot_thirst_probe.controls;
  const filled = (level) => {
    const panel = namedControl(ring, `ot_thirst_ring_${String(level).padStart(2, "0")}`);
    const result = new Set();
    for (const entry of panel.controls) {
      const { uv: [x, y], uv_size: [width, height] } = Object.values(entry)[0];
      for (let py = y; py < y + height; py++) for (let px = x; px < x + width; px++)
        result.add(`${px},${py}`);
    }
    return result;
  };
  const arcStart = Math.atan2(3.5, 11.5);
  const arcEnd = 2 * Math.PI - arcStart;
  assert.ok(filled(1).has("8,0"), "最后一格应留在顶部缺口左侧");
  assert.ok(!filled(95).has("15,0"), "第一格应从顶部缺口右侧消退");
  for (let level = 95; level >= 1; level--) {
    const current = filled(level);
    const cutoff = arcEnd - (arcEnd - arcStart) * level / 96;
    for (let y = 0; y < 24; y++) for (let x = 0; x < 24; x++) {
      const angle = (Math.atan2(x + 0.5 - 12, 12 - y - 0.5) + 2 * Math.PI) % (2 * Math.PI);
      assert.equal(current.has(`${x},${y}`), angle >= cutoff && angle <= arcEnd,
        `口渴 ${level} 档圆环 ${x},${y} 必须沿单一圆弧消退`);
    }
  }
});

test("temperature marker and cold recovery multiplier integrate without changing stamina costs", () => {
  const scene = harness();
  scene.worldProperties.delete("ot:temperature_enabled");
  scene.properties.set("ot:temperature_tier", 4);
  scene.tick();
  assert.equal(scene.titles.at(-1).title, "OT_STATUS|S:96|T:96|C:4|");
  scene.worldProperties.set("ot:temperature_enabled", false);
  scene.tick();
  assert.equal(scene.titles.at(-1).title, "OT_STATUS|S:96|T:96|");
  scene.command("25");
  scene.properties.set("ot:stamina_recovery_multiplier", 0.5);
  scene.tick(20);
  assert.equal(scene.properties.get("ot:stamina_value"), 29);
  scene.player.isSprinting = true;
  scene.tick(20);
  assert.equal(scene.properties.get("ot:stamina_value"), 26);
});

test("temperature can show without stamina or thirst, and thirst ring hides independently", () => {
  const scene = harness();
  scene.worldProperties.delete("ot:temperature_enabled");
  scene.setStaminaEnabled(false);
  scene.setThirstEnabled(false);
  scene.tick();
  assert.equal(scene.titles.at(-1).title, "OT_STATUS|C:2|");
  scene.worldProperties.set("ot:temperature_enabled", false);
  scene.tick();
  assert.equal(scene.titles.at(-1).title, "OT_STATUS_OFF");
});

for (const [edition, implementation] of [["full", script], ["compat", compatScript]])
test(`${edition}: stamina recovers 4/s for walking, water and gliding, 8/s for rest or sneaking outside water`, () => {
  const scene = harness("survival", {}, implementation);
  scene.command("40");
  scene.player.velocity.x = 0.1;
  scene.tick(20);
  assert.ok(Math.abs(scene.staminaValue() - 44) < 1e-6);
  scene.player.isInWater = true;
  scene.player.isSneaking = true;
  scene.player.velocity.x = 0;
  scene.tick(20);
  assert.ok(Math.abs(scene.staminaValue() - 48) < 1e-6, "water never gets fast recovery");
  scene.player.isSwimming = true;
  scene.tick(20);
  assert.ok(Math.abs(scene.staminaValue() - 44) < 1e-6, "active swimming still costs four per second");
  scene.player.isSwimming = scene.player.isInWater = false;
  scene.player.isGliding = scene.player.isSprinting = true;
  scene.tick(20);
  assert.ok(Math.abs(scene.staminaValue() - 48) < 1e-6, "gliding overrides a lingering sprint flag");
  scene.player.isGliding = scene.player.isSprinting = false;
  scene.player.velocity.x = 0.1;
  scene.tick(20);
  assert.ok(Math.abs(scene.staminaValue() - 56) < 1e-6);
  scene.player.isSneaking = false;
  scene.player.velocity.x = 0;
  scene.tick(20);
  assert.ok(Math.abs(scene.staminaValue() - 64) < 1e-6);
  scene.command("0");
  scene.player.isGliding = true;
  scene.tick(20);
  assert.ok(Math.abs(scene.staminaValue() - 4) < 1e-6, "exhausted stationary gliding uses the slow rate too");
  scene.player.isGliding = false;
  scene.player.isInWater = scene.player.isSneaking = true;
  scene.tick(20);
  assert.ok(Math.abs(scene.staminaValue() - 8) < 1e-6);
  scene.player.isInWater = scene.player.isSneaking = false;
  scene.tick(20);
  assert.ok(Math.abs(scene.staminaValue() - 16) < 1e-6);
  scene.tick(11);
  assert.equal(scene.permissions.jump, true);
});

test("survival activity drains, walking and treading recover slowly, sneaking recovers quickly", () => {
  const scene = harness();
  scene.player.velocity.x = 0.1;
  scene.player.isSprinting = true;
  scene.tick(100);
  assert.equal(scene.properties.get("ot:stamina_value"), 85);
  scene.player.isSprinting = false;
  scene.tick(20);
  assert.equal(scene.properties.get("ot:stamina_value"), 89);
  scene.player.isInWater = true;
  scene.tick(20);
  assert.equal(scene.properties.get("ot:stamina_value"), 93);
  scene.player.isSwimming = true;
  scene.tick(20);
  assert.equal(scene.properties.get("ot:stamina_value"), 89);
  scene.player.isSwimming = false;
  scene.player.isInWater = false;
  scene.player.isSneaking = true;
  scene.tick(20);
  assert.equal(scene.properties.get("ot:stamina_value"), 97);
  scene.player.isSneaking = false;
  scene.player.velocity.x = 0;
  scene.tick(20);
  assert.equal(scene.properties.get("ot:stamina_value"), 100);
});

test("a real jump costs stamina once, not every tick while jump is held", () => {
  const scene = harness();
  scene.tick();
  scene.command("50");
  scene.player.isJumping = true;
  scene.player.isOnGround = false;
  scene.player.velocity.y = 0.3;
  scene.tick();
  assert.ok(Math.abs(scene.staminaValue() - 48.2) < 1e-6);
  scene.tick(9);
  assert.ok(Math.abs(scene.staminaValue() - 50) < 1e-6);
});

test("zero stamina disables jump until 20 and temporarily slows sprint/swim", () => {
  const scene = harness();
  scene.tick();
  scene.command("0");
  assert.equal(scene.permissions.jump, false);
  assert.equal(scene.properties.get("ot:stamina_exhausted"), true);
  scene.player.isSprinting = true;
  scene.player.velocity.x = 0.1;
  scene.tick(50);
  assert.equal(scene.permissions.jump, false);
  assert.ok(scene.effects.some(([effect, duration, options]) =>
    effect === "slowness" && duration === 6 && options.amplifier === 2));
  scene.player.isSprinting = false;
  scene.player.velocity.x = 0;
  scene.tick(24);
  assert.equal(scene.permissions.jump, false);
  scene.tick(2);
  assert.equal(scene.permissions.jump, true);
  assert.equal(scene.properties.get("ot:stamina_exhausted"), false);
  assert.ok(scene.properties.get("ot:stamina_value") >= 20);
});

test("stamina and owned jump lock survive rejoin; death and creative release the lock", () => {
  const scene = harness();
  scene.tick();
  scene.command("0");
  scene.player.velocity.x = 0.1;
  scene.tick(50);
  scene.leave();
  scene.tick();
  assert.equal(scene.permissions.jump, false);
  scene.respawn();
  assert.equal(scene.permissions.jump, true);
  assert.equal(scene.properties.get("ot:stamina_value"), 100);
  scene.command("0");
  assert.equal(scene.permissions.jump, false);
  scene.player.mode = "creative";
  scene.tick();
  assert.equal(scene.permissions.jump, true);
});

test("a jump restriction owned by another system is never cleared by stamina", () => {
  const scene = harness();
  scene.permissions.jump = false;
  scene.tick();
  scene.command("0");
  assert.equal(scene.properties.get("ot:stamina_jump_owned"), undefined);
  scene.tick(101);
  assert.equal(scene.properties.get("ot:stamina_exhausted"), false);
  assert.equal(scene.permissions.jump, false);
  assert.deepEqual(scene.permissions.changes, []);
});

test("manual test remains available to operators in creative without an idle title loop", () => {
  const scene = harness("creative");
  scene.tick();
  assert.equal(scene.titles.length, 0);
  scene.command("on");
  assert.equal(scene.titles.at(-1).title, "OT_STATUS|S:96|");
  scene.command("25");
  scene.tick(19);
  assert.equal(scene.titles.at(-1).title, "OT_STATUS|S:24|");
  scene.command("0");
  scene.tick(6);
  assert.equal(scene.titles.at(-1).title, "OT_STATUS|S:0|");
  scene.command("1");
  assert.equal(scene.titles.at(-1).title, "OT_STATUS|S:1|");
  const count = scene.titles.length;
  scene.tick(40);
  assert.equal(scene.titles.length, count);
  scene.command("off");
  assert.equal(scene.titles.at(-1).title, "OT_STATUS_OFF");
  scene.player.playerPermissionLevel = 1;
  scene.command("on");
  assert.equal(scene.titles.at(-1).title, "OT_STATUS_OFF");
});

test("both meters share one HUD message and creative debug can show thirst alone", () => {
  const scene = harness();
  scene.tick();
  assert.equal(scene.titles.at(-1).title, "OT_STATUS|S:96|T:96|");
  scene.player.mode = "creative";
  scene.tick();
  assert.equal(scene.titles.at(-1).title, "OT_STATUS_OFF");
  scene.command("25", "ot:thirst_test");
  assert.equal(scene.titles.at(-1).title, "OT_STATUS|T:24|");
  scene.command("off", "ot:thirst_test");
  assert.equal(scene.titles.at(-1).title, "OT_STATUS_OFF");
});

test("thirst uses independent 40:1 movement prices without the old sprint/jump charges", () => {
  const scene = harness();
  scene.tick(400);
  assert.equal(scene.properties.get("ot:thirst_value"), 99);
  scene.command("100", "ot:thirst_test");
  scene.player.isSprinting = true;
  scene.tick(200);
  assert.equal(scene.properties.get("ot:thirst_value"), 99);
  assert.ok(Math.abs(scene.thirstValue() - 98.75) < 1e-6);
  scene.command("100", "ot:thirst_test");
  scene.player.isSprinting = false;
  scene.tick();
  for (let i = 0; i < 4; i++) {
    scene.player.isOnGround = false;
    scene.player.isJumping = true;
    scene.player.velocity.y = 0.3;
    scene.tick();
    scene.player.isOnGround = true;
    scene.tick();
  }
  assert.ok(Math.abs(scene.thirstValue() - 99.7775) < 1e-6,
    "四次起跳各失水 0.05，不再按旧值 0.08 扣");
});

test("run, jump and punch add distinct thirst costs even with stamina switched off", () => {
  for (const [hit, expected] of [[false, 99.8], [true, 99.775]]) {
    const scene = harness();
    scene.tick();
    scene.command("50");
    scene.command("100", "ot:thirst_test");
    scene.setStaminaEnabled(false);
    scene.player.isSprinting = true;
    scene.swing();
    if (hit) scene.hit();
    scene.player.isOnGround = false;
    scene.player.isJumping = true;
    scene.player.velocity.y = 0.3;
    scene.tick();
    scene.player.isOnGround = true;
    scene.player.isJumping = false;
    scene.player.velocity.y = 0;
    scene.tick(19);
    assert.ok(Math.abs(scene.thirstValue() - expected) < 1e-6);
    assert.equal(scene.properties.get("ot:stamina_value"), 50,
      "体力关掉后，口渴仍独立识别这些动作");
  }
});

test("both systems price the same actions independently at the agreed 40:1 ratio", () => {
  const scene = harness();
  scene.tick();
  scene.command("100", "ot:thirst_test");
  scene.player.isSprinting = true;
  scene.swing();
  scene.hit();
  scene.player.isOnGround = false;
  scene.player.isJumping = true;
  scene.player.velocity.y = 0.3;
  scene.tick();
  scene.player.isOnGround = true;
  scene.player.isJumping = false;
  scene.tick(19);
  assert.equal(scene.properties.get("ot:stamina_value"), 93);
  assert.ok(Math.abs(scene.thirstValue() - 99.775) < 1e-6);
});

test("swimming, mining and bow draw have their own thirst prices with stamina off", () => {
  const scene = harness();
  scene.tick();
  scene.setStaminaEnabled(false);
  scene.command("100", "ot:thirst_test");
  scene.player.isSwimming = true;
  scene.player.isSprinting = true;
  scene.tick(20);
  assert.ok(Math.abs(scene.thirstValue() - 99.85) < 1e-6,
    "游泳优先于冲刺，基础 0.05 加游泳 0.1");
  scene.player.isSwimming = scene.player.isSprinting = false;
  scene.command("100", "ot:thirst_test");
  scene.mineStart();
  scene.tick(20);
  assert.ok(Math.abs(scene.thirstValue() - 99.9) < 1e-6);
  scene.mineCancel();
  scene.command("100", "ot:thirst_test");
  scene.bowStart();
  scene.tick(20);
  assert.ok(Math.abs(scene.thirstValue() - 99.925) < 1e-6);
  scene.bowStop();
});

test("thirst switch freezes exertion loss without disabling stamina", () => {
  const scene = harness();
  scene.tick();
  scene.command("50", "ot:thirst_test");
  scene.setThirstEnabled(false);
  scene.player.isSprinting = true;
  scene.mineStart();
  scene.bowStart();
  scene.swing();
  scene.hit();
  scene.tick(20);
  assert.equal(scene.thirstValue(), 50);
  assert.ok(scene.properties.get("ot:stamina_value") < 100);
});

test("thirst still prices an attempted swing while exhausted stamina recovers", () => {
  const scene = harness();
  scene.tick();
  scene.command("0");
  scene.command("50", "ot:thirst_test");
  scene.swing();
  scene.tick(2);
  assert.ok(scene.properties.get("ot:stamina_value") > 0);
  assert.ok(scene.properties.get("ot:stamina_value") < 20);
  assert.equal(scene.tryHurt(), true);
  assert.ok(Math.abs(scene.thirstValue() - 49.97) < 1e-6,
    "挥空 0.025 加两刻基础失水 0.005，与体力锁无数值依赖");
});

test("heat scales base and exertion thirst losses, while submerged head restores", () => {
  const scene = harness();
  scene.tick();
  scene.command("100", "ot:thirst_test");
  scene.properties.set("ot:thirst_loss_multiplier", 1.5);
  scene.player.isSprinting = true;
  scene.swing();
  scene.hit();
  scene.player.isOnGround = false;
  scene.player.isJumping = true;
  scene.player.velocity.y = 0.3;
  scene.tick();
  scene.player.isOnGround = true;
  scene.player.isJumping = false;
  scene.tick(19);
  assert.ok(Math.abs(scene.thirstValue() - 99.6625) < 1e-6,
    "跑跳命中的 0.225 总失水一起乘热环境 1.5");

  scene.command("50", "ot:thirst_test");
  scene.player.isInWater = true;
  scene.player.headBlockType = "minecraft:water";
  scene.mineStart();
  scene.bowStart();
  scene.tick(20);
  assert.ok(Math.abs(scene.thirstValue() - 51) < 1e-6,
    "头浸水时补水优先于持续活动失水");
});

test("only a submerged head restores thirst and heat multiplier affects losses only", () => {
  const scene = harness();
  scene.command("50", "ot:thirst_test");
  scene.player.isInWater = true;
  scene.tick(400);
  assert.equal(scene.properties.get("ot:thirst_value"), 49);
  scene.player.headBlockType = "minecraft:flowing_water";
  scene.properties.set("ot:thirst_loss_multiplier", 2);
  scene.tick(20);
  assert.equal(scene.properties.get("ot:thirst_value"), 50);
  scene.player.isInWater = false;
  scene.tick(200);
  assert.equal(scene.properties.get("ot:thirst_value"), 49);
});

for (const [edition, implementation] of [["full", script], ["compat", compatScript]]) {
test(`${edition}: exposed rain replaces loss with 0.1/s, but roofs, dimensions and switches still gate it`, () => {
  const scene = harness("survival", {}, implementation);
  scene.tick();
  scene.command("50", "ot:thirst_test");
  scene.worldProperties.set("ot:temperature_weather", "Rain");
  scene.tick(400);
  assert.ok(Math.abs(scene.thirstValue() - 52) < 1e-6, "淋雨 20 秒净补 2 点");
  scene.player.roofed = true;
  scene.tick(20);
  assert.ok(Math.abs(scene.thirstValue() - 51.95) < 1e-6);
  scene.player.roofed = false;
  scene.player.dimension.id = "minecraft:nether";
  const beforeNether = scene.thirstValue();
  scene.tick(20);
  assert.ok(Math.abs(scene.thirstValue() - beforeNether + 0.05) < 1e-6);
  scene.player.dimension.id = "minecraft:overworld";
  scene.setThirstEnabled(false);
  const frozen = scene.thirstValue();
  scene.tick(40);
  assert.equal(scene.thirstValue(), frozen);
  scene.setThirstEnabled(true);
  scene.command("100", "ot:thirst_test");
  scene.tick(20);
  assert.equal(scene.thirstValue(), 100);
  scene.command("50", "ot:thirst_test");
  scene.player.mode = "creative";
  scene.tick(20);
  assert.equal(scene.thirstValue(), 50);
});

test(`${edition}: rain waives ongoing and instant activity costs and never stacks with submerged-head gain`, () => {
  const scene = harness("survival", {}, implementation);
  scene.tick();
  scene.command("50", "ot:thirst_test");
  scene.worldProperties.set("ot:temperature_weather", "Thunder");
  scene.properties.set("ot:thirst_loss_multiplier", 4);
  scene.setStaminaEnabled(false);
  scene.player.isSprinting = true;
  scene.player.isJumping = true;
  scene.hit();
  assert.equal(scene.thirstValue(), 50, "rain waives the instant melee fee");
  scene.mineBreak();
  assert.equal(scene.thirstValue(), 50, "rain waives instant block-break fees");
  if (edition === "full") scene.mineStart();
  scene.bowStart();
  scene.tick(20);
  assert.ok(Math.abs(scene.thirstValue() - 50.1) < 1e-6);
  scene.mineBreak();
  assert.ok(Math.abs(scene.thirstValue() - 50.1) < 1e-6);
  scene.bowStop();
  scene.bowStart("minecraft:crossbow");
  scene.tick(20);
  assert.ok(Math.abs(scene.thirstValue() - 50.2) < 1e-6);
  scene.player.isInWater = true;
  scene.player.headBlockType = "minecraft:water";
  const before = scene.thirstValue();
  scene.tick(20);
  assert.ok(Math.abs(scene.thirstValue() - before - 1) < 1e-6);
  if (edition === "full") {
    const late = harness();
    late.command("50", "ot:thirst_test");
    late.worldProperties.set("ot:temperature_weather", "Rain");
    late.swing();
    late.tick(3);
    assert.ok(Math.abs(late.thirstValue() - 50.015) < 1e-6, "rain waives a settled miss");
    const beforeCorrection = late.thirstValue();
    late.hit();
    assert.equal(late.thirstValue(), beforeCorrection, "late-hit correction cannot charge hidden rain loss");
  }
});
}

test("finished drinks use separate gains, honey and ominous bottles do not hydrate", () => {
  const scene = harness();
  scene.command("20", "ot:thirst_test");
  scene.drink("minecraft:potion", "minecraft:water");
  assert.equal(scene.properties.get("ot:thirst_value"), 45);
  scene.drink("minecraft:milk_bucket");
  assert.equal(scene.properties.get("ot:thirst_value"), 65);
  scene.drink("minecraft:potion", "minecraft:healing");
  assert.equal(scene.properties.get("ot:thirst_value"), 70);
  scene.drink("minecraft:mushroom_stew");
  assert.equal(scene.properties.get("ot:thirst_value"), 80);
  scene.drink("minecraft:honey_bottle");
  scene.drink("minecraft:ominous_bottle");
  assert.equal(scene.properties.get("ot:thirst_value"), 80);
});

for (const [edition, implementation] of [["full", script], ["compat", compatScript]])
test(`${edition}: thirst hurts every five seconds below twenty, every two at zero, and can kill`, () => {
  const scene = harness("survival", {}, implementation);
  scene.player.health = 2;
  scene.command("19", "ot:thirst_test");
  scene.tick(99);
  assert.equal(scene.player.health, 2);
  scene.tick();
  assert.equal(scene.player.health, 1);
  scene.command("0", "ot:thirst_test");
  scene.tick(39);
  assert.equal(scene.player.health, 1);
  scene.tick();
  assert.equal(scene.player.health, 0);
  assert.ok(scene.effects.some(([effect, , options]) =>
    effect === "nausea" && options.amplifier === 0));
  scene.respawn();
  assert.equal(scene.properties.get("ot:thirst_value"), 100);
  scene.player.health = 10;
  scene.command("19", "ot:thirst_test");
  scene.tick(99);
  assert.equal(scene.player.health, 10);
  scene.command("0", "ot:thirst_test");
  scene.tick(39);
  assert.equal(scene.player.health, 10, "entering severe thirst resets the damage timer");
  scene.tick();
  assert.equal(scene.player.health, 9);
  scene.command("25", "ot:thirst_test");
  scene.tick(120);
  assert.equal(scene.player.health, 9, "hydrating above twenty stops damage");
  scene.command("0", "ot:thirst_test");
  scene.setThirstEnabled(false);
  scene.tick(100);
  assert.equal(scene.player.health, 9, "disabled thirst never deals hidden damage");
  scene.setThirstEnabled(true);
  scene.tick(39);
  assert.equal(scene.player.health, 9);
  scene.tick();
  assert.equal(scene.player.health, 8);
});

test("zero thirst keeps nausea active long enough before refreshing it", () => {
  const scene = harness();
  scene.command("0", "ot:thirst_test");
  scene.tick();
  assert.equal(scene.effects[0][0], "nausea");
  assert.equal(scene.effects[0][1], 200);
  scene.tick(159);
  assert.equal(scene.effects.filter(([name]) => name === "nausea").length, 1);
  scene.tick();
  assert.equal(scene.effects.filter(([name]) => name === "nausea").length, 2);
  scene.command("100", "ot:thirst_test");
  scene.tick(200);
  assert.equal(scene.effects.filter(([name]) => name === "nausea").length, 2);
});

test("world switches default on; disabling stops each system and hides its bar", () => {
  const scene = harness();
  scene.tick();
  assert.equal(scene.titles.at(-1).title, "OT_STATUS|S:96|T:96|");
  scene.command("0");
  assert.equal(scene.permissions.jump, false);
  scene.setStaminaEnabled(false);
  scene.tick();
  assert.equal(scene.worldProperties.get("ot:stamina_enabled"), false);
  assert.equal(scene.permissions.jump, true);
  assert.equal(scene.titles.at(-1).title, "OT_STATUS|T:96|");
  scene.tick(100);
  assert.equal(scene.properties.get("ot:stamina_value"), 0);

  scene.command("0", "ot:thirst_test");
  scene.player.health = 10;
  scene.setThirstEnabled(false);
  scene.tick(200);
  assert.equal(scene.worldProperties.get("ot:thirst_enabled"), false);
  assert.equal(scene.player.health, 10);
  assert.equal(scene.titles.at(-1).title, "OT_STATUS_OFF");
  scene.drink("minecraft:potion", "minecraft:water");
  assert.equal(scene.properties.get("ot:thirst_value"), 0);
  scene.setThirstEnabled(true);
  scene.tick(40);
  assert.equal(scene.player.health, 9);
  assert.equal(scene.titles.at(-1).title.startsWith("OT_STATUS|T:"), true);
});

test("only a melee hit pauses recovery for ten ticks; misses recover normally", () => {
  const scene = harness();
  scene.tick();
  scene.command("50");
  scene.swing();
  scene.tick(2);
  assert.equal(scene.staminaValue(), 49);
  scene.tick();
  assert.equal(scene.staminaValue(), 49.4);
  scene.command("50");
  scene.swing();
  scene.hit();
  scene.hit(); // One swing may touch more than one entity; charge it only once.
  scene.tick(2);
  assert.equal(scene.staminaValue(), 48);
  scene.tick(8);
  assert.equal(scene.staminaValue(), 48);
  scene.tick();
  assert.equal(scene.staminaValue(), 48.4);
});

test("a melee hit arriving after the two-tick swing settlement is still a hit", () => {
  const scene = harness();
  scene.tick();
  scene.command("50");
  scene.command("100", "ot:thirst_test");
  scene.swing();
  scene.tick(2);
  scene.hit();
  assert.equal(scene.staminaValue(), 48);
  assert.ok(Math.abs(scene.thirstValue() - 99.945) < 1e-6);
  scene.tick(10);
  assert.equal(scene.staminaValue(), 48, "迟到的命中也应暂停半秒恢复");
  scene.tick();
  assert.equal(scene.staminaValue(), 48.4);
});

test("actual melee damage confirms a hit if the contact callback is missed", () => {
  const scene = harness();
  scene.tick();
  scene.command("50");
  scene.command("100", "ot:thirst_test");
  scene.swing();
  scene.tick(2);
  scene.meleeDamage();
  assert.equal(scene.staminaValue(), 48);
  assert.ok(Math.abs(scene.thirstValue() - 99.945) < 1e-6);
  scene.hit();
  assert.equal(scene.staminaValue(), 48, "同一次攻击不能因两个事件重复计费");
  scene.tick(10);
  assert.equal(scene.staminaValue(), 48);
});

test("rapid empty swings drain stamina instead of bouncing between 99 and 100", () => {
  const scene = harness();
  scene.tick();
  for (let i = 0; i < 10; i++) {
    scene.swing();
    scene.tick(2);
  }
  assert.equal(scene.staminaValue(), 90, "10 次服务端挥拳事件应各扣 1 点且不被空闲回复抵消");
});

test("melee contact arriving before the swing callback is still charged as a hit", () => {
  const scene = harness();
  scene.tick();
  scene.command("50");
  scene.hit();
  scene.swing();
  scene.tick(2);
  assert.equal(scene.staminaValue(), 48);
  scene.tick(8);
  assert.equal(scene.staminaValue(), 48, "命中后不应立刻恢复");
});

test("confirmed melee damage is charged even when no swing callback arrives", () => {
  const scene = harness();
  scene.tick();
  scene.command("50");
  scene.command("100", "ot:thirst_test");
  scene.meleeDamage();
  scene.hit(); // Two confirmation events for the same attack must not double-charge.
  assert.equal(scene.staminaValue(), 48);
  assert.ok(Math.abs(scene.thirstValue() - 99.95) < 1e-6);
  scene.tick(10);
  assert.equal(scene.staminaValue(), 48);
  scene.tick();
  assert.equal(scene.staminaValue(), 48.4);
});

test("contact then swing in the next tick costs only one hit, not an extra miss", () => {
  const scene = harness();
  scene.tick();
  scene.command("50");
  scene.hit();
  scene.tick();
  scene.swing();
  scene.meleeDamage();
  scene.tick(2);
  assert.equal(scene.staminaValue(), 48);
});

test("contact and damage callbacks one tick apart do not double-charge", () => {
  const scene = harness();
  scene.tick();
  scene.command("50");
  scene.hit();
  scene.tick();
  scene.meleeDamage();
  assert.equal(scene.staminaValue(), 48);
});

test("separate quick hits on the same target are not mistaken for duplicate callbacks", () => {
  const scene = harness();
  scene.tick();
  scene.command("50");
  for (let i = 0; i < 5; i++) {
    scene.swing();
    scene.hit();
    scene.tick(2);
  }
  assert.equal(scene.staminaValue(), 40);
});

test("exhausted empty swings do not prevent stamina recovery", () => {
  const scene = harness();
  scene.tick();
  scene.command("0");
  for (let i = 0; i < 5; i++) {
    scene.swing();
    scene.tick(4);
  }
  assert.ok(Math.abs(scene.staminaValue() - 8) < 1e-6);
});

test("mining costs 2/s and bow draw costs 1/s instead of idle recovery", () => {
  const scene = harness();
  scene.tick();
  scene.command("50");
  scene.mineStart();
  scene.tick(20);
  assert.equal(scene.properties.get("ot:stamina_value"), 48);
  scene.mineCancel();
  scene.tick(20);
  assert.equal(scene.properties.get("ot:stamina_value"), 56);
  scene.command("50");
  scene.bowStart();
  scene.tick(20);
  assert.equal(scene.properties.get("ot:stamina_value"), 49);
  scene.bowRelease();
  scene.tick(20);
  assert.equal(scene.properties.get("ot:stamina_value"), 57);
  scene.command("50");
  scene.player.isSprinting = true;
  scene.mineStart();
  scene.tick(20);
  assert.equal(scene.properties.get("ot:stamina_value"), 45, "冲刺与挖掘成本相加");
  scene.player.isSprinting = false;
  scene.player.mineBlockType = "minecraft:air";
  scene.tick(20);
  assert.equal(scene.properties.get("ot:stamina_value"), 53, "被脚本移除的方块不再继续计挖掘");
});

test("crossbow charging costs 2 stamina and 0.05 thirst per second, then stops when loaded", () => {
  const scene = harness();
  scene.tick();
  scene.command("50");
  scene.command("100", "ot:thirst_test");
  scene.bowStart("minecraft:crossbow");
  scene.tick(20);
  assert.ok(Math.abs(scene.staminaValue() - 48) < 1e-6);
  assert.ok(Math.abs(scene.thirstValue() - 99.9) < 1e-6);
  scene.completeUse("minecraft:crossbow");
  scene.tick(20);
  assert.ok(Math.abs(scene.staminaValue() - 56) < 1e-6, "已上膛后恢复体力，不再计装填费");
  assert.ok(Math.abs(scene.thirstValue() - 99.85) < 1e-6, "已上膛后只计基础失水");
});

test("crossbow thirst cost survives stamina switch and exhausted use is cancelled", () => {
  const scene = harness();
  scene.tick();
  scene.command("50");
  scene.command("100", "ot:thirst_test");
  scene.setStaminaEnabled(false);
  scene.bowStart("minecraft:crossbow");
  scene.tick(20);
  assert.equal(scene.staminaValue(), 50);
  assert.ok(Math.abs(scene.thirstValue() - 99.9) < 1e-6);
  scene.completeUse("minecraft:crossbow");
  scene.setStaminaEnabled(true);
  scene.command("0");
  assert.equal(scene.tryUse("minecraft:crossbow"), true);
  scene.tick(4);
  assert.ok(scene.staminaValue() > 0, "无效的弩操作不能卡住耗尽恢复");
});

test("exhaustion cancels break, melee, projectile and chargeable weapons until 20 stamina", () => {
  const scene = harness();
  scene.tick();
  scene.command("0");
  assert.equal(scene.tryBreak(), true);
  assert.equal(scene.tryHurt(), true);
  assert.equal(scene.tryHurt("projectile"), true);
  assert.equal(scene.tryProjectileOwner(), true);
  assert.equal(scene.tryUse(), true);
  assert.equal(scene.tryUse("minecraft:crossbow"), true);
  assert.equal(scene.tryUse("minecraft:apple"), false);
  scene.mineStart();
  scene.bowStart();
  scene.tick(20);
  assert.equal(scene.properties.get("ot:stamina_value"), 8, "无效的挖掘／拉弓尝试不能阻止恢复");
  scene.mineBreak();
  scene.bowStop();
  scene.tick(80);
  assert.ok(scene.properties.get("ot:stamina_value") >= 20);
  assert.equal(scene.tryBreak(), false);
  assert.equal(scene.tryHurt(), false);
  assert.equal(scene.tryUse(), false);
  scene.setStaminaEnabled(false);
  assert.equal(scene.tryBreak(), false);
  assert.equal(scene.tryHurt(), false);
});

test("futile mining, attacking and bow attempts do not trap exhausted stamina at zero", () => {
  for (const attempt of ["mineStart", "swing", "bowStart"]) {
    const scene = harness();
    scene.tick();
    scene.command("0");
    scene[attempt]();
    scene.tick(4);
    assert.ok(scene.properties.get("ot:stamina_value") > 0, `${attempt} must not block recovery`);
  }
});

test("drawing a bow at zero stamina does not repeatedly reapply movement slowdown", () => {
  const scene = harness();
  scene.tick();
  scene.command("0");
  scene.bowStart();
  scene.player.isSprinting = true;
  scene.tick(6);
  assert.equal(scene.effects.filter(([effect]) => effect === "slowness").length, 0);
});

test("instant block break costs stamina even when start and break occur before one tick", () => {
  const scene = harness();
  scene.tick();
  scene.command("50");
  scene.mineStart();
  scene.mineBreak();
  assert.equal(scene.properties.get("ot:stamina_value"), 49);
  scene.command("50");
  scene.mineBreak();
  assert.equal(scene.properties.get("ot:stamina_value"), 49, "即使未收到开始挖掘事件，实际破坏仍计费");
  scene.command("50");
  scene.mineStart();
  scene.tick(3);
  scene.mineBreak();
  assert.equal(scene.properties.get("ot:stamina_value"), 49, "短暂挖掘补足到每块最低 1 点");
  scene.command("50");
  scene.mineStart();
  scene.tick(20);
  scene.mineBreak();
  assert.equal(scene.properties.get("ot:stamina_value"), 48, "长时间挖掘已有 2 点费用，不重复收取");
  scene.setStaminaEnabled(false);
  scene.mineBreak();
  assert.equal(scene.properties.get("ot:stamina_value"), 48);
});

test("instant mining keeps the independent 40:1 thirst price without double-charging slow mining", () => {
  const quick = harness();
  quick.tick();
  quick.command("50", "ot:thirst_test");
  quick.setStaminaEnabled(false);
  quick.mineBreak();
  assert.ok(Math.abs(quick.thirstValue() - 49.975) < 1e-6);

  const slow = harness();
  slow.tick();
  slow.command("50", "ot:thirst_test");
  slow.mineStart();
  slow.tick(20);
  const beforeBreak = slow.thirstValue();
  slow.mineBreak();
  assert.ok(Math.abs(slow.thirstValue() - beforeBreak) < 1e-6);
});

test("physical injury costs two stamina but periodic internal damage does not", () => {
  const scene = harness();
  scene.tick();
  scene.command("50");
  scene.hurt("entityAttack");
  assert.equal(scene.properties.get("ot:stamina_value"), 48);
  for (const cause of ["none", "temperature", "fireTick", "starve"]) scene.hurt(cause);
  assert.equal(scene.properties.get("ot:stamina_value"), 48);
  scene.hurt("fall");
  assert.equal(scene.properties.get("ot:stamina_value"), 46);
  scene.hurt("maceSmash");
  assert.equal(scene.properties.get("ot:stamina_value"), 44);
  scene.setStaminaEnabled(false);
  scene.hurt("projectile");
  assert.equal(scene.properties.get("ot:stamina_value"), 44);
  scene.setStaminaEnabled(true);
  scene.player.mode = "creative";
  scene.hurt("entityAttack");
  assert.equal(scene.properties.get("ot:stamina_value"), 44);
});

test("physical injury pauses recovery for ten ticks, and a second hit refreshes rather than stacks", () => {
  const scene = harness();
  scene.tick();
  scene.command("50");
  scene.hurt("entityAttack");
  scene.tick(8);
  assert.equal(scene.staminaValue(), 48);
  scene.hurt("fall");
  scene.tick(10);
  assert.equal(scene.staminaValue(), 46);
  scene.tick();
  assert.equal(scene.staminaValue(), 46.4);

  const tired = harness();
  tired.tick();
  tired.command("0");
  tired.hurt("projectile");
  tired.tick(10);
  assert.equal(tired.staminaValue(), 0, "耗尽状态也应暂停恢复");
  tired.tick();
  assert.equal(tired.staminaValue(), 0.4);
});

test("injury pause does not stop exertion and is cleared by switch or respawn", () => {
  const running = harness();
  running.tick();
  running.command("50");
  running.hurt("entityAttack");
  running.player.isSprinting = true;
  running.tick(10);
  assert.ok(Math.abs(running.staminaValue() - 46.5) < 1e-6);

  const internal = harness();
  internal.tick();
  internal.command("50");
  internal.hurt("temperature");
  internal.tick();
  assert.equal(internal.staminaValue(), 50.4);

  internal.hurt("fall");
  internal.setStaminaEnabled(false);
  internal.tick();
  internal.setStaminaEnabled(true);
  internal.tick();
  assert.ok(Math.abs(internal.staminaValue() - 48.8) < 1e-6);

  internal.hurt("fall");
  internal.respawn();
  internal.command("50");
  internal.tick();
  assert.equal(internal.staminaValue(), 50.4);
});

