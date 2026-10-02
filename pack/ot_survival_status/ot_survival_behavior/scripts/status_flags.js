import { world } from "@minecraft/server";

const OBJECTIVE = "ot_status_flags";

export function statusEnabled(name) {
  let score;
  try {
    score = world.scoreboard.getObjective(OBJECTIVE)?.getScore(`#${name}`);
  } catch { /* A fake participant may not exist yet. */ }
  return score === undefined ? world.getDynamicProperty(`ot:${name}_enabled`) !== false : score !== 0;
}

export function setStatusEnabled(name, enabled) {
  const objective = world.scoreboard.getObjective(OBJECTIVE) ??
    world.scoreboard.addObjective(OBJECTIVE, OBJECTIVE);
  objective.setScore(`#${name}`, enabled ? 1 : 0);
  world.setDynamicProperty(`ot:${name}_enabled`, enabled);
}

export function legacyScore(player, objectiveName) {
  let score;
  try {
    score = world.scoreboard.getObjective(objectiveName)?.getScore(player.scoreboardIdentity ?? player);
  } catch {
    return undefined;
  }
  return typeof score === "number" && Number.isFinite(score) ? score : undefined;
}
