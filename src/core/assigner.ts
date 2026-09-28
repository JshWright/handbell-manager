/**
 * Balance bell notes across players, strongly preferring pitch-adjacent
 * groupings, while never letting one player be asked to ring two bells at
 * the same instant (or within a configurable gap).
 */
import { NoteEvent } from './mscz-parser';
import { SeededRandom } from './rng';

export interface Assignment {
  players: string[][];          // bell names per player, in pitch order
  playerSums: number[];         // total strikes per player
  spread: number;               // max - min strikes across players
  counts: Record<string, number>;
  pitchCost: number;
  conflicts: Record<string, string[]>;
  playerNames: string[] | null;
  pinned: Record<string, number>;
  minCount: number | null;
  minGapBeats: number | null;
  handsPerPlayer: number;       // 1 = strict independent set, 2 = two-hand (bipartite) ringing
  hands: Record<string, number>; // bell name -> 0 (left) or 1 (right); lowest-pitch bell per player is always 0
  hasConflicts: boolean;        // true when some player's bells aren't splittable into `handsPerPlayer` conflict-free hands
}

export function buildConflictGraph(
  events: NoteEvent[],
  minGapTicks = 0,
): Record<string, Set<string>> {
  const byNote = new Map<string, NoteEvent[]>();
  for (const e of events) {
    if (!byNote.has(e.name)) byNote.set(e.name, []);
    byNote.get(e.name)!.push(e);
  }

  const conflict: Record<string, Set<string>> = {};
  const names = [...byNote.keys()];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i], b = names[j];
      let hit = false;
      outer: for (const ea of byNote.get(a)!) {
        for (const eb of byNote.get(b)!) {
          const gap = Math.max(eb.onset - ea.end, ea.onset - eb.end);
          if (gap < minGapTicks) { hit = true; break outer; }
        }
      }
      if (hit) {
        if (!conflict[a]) conflict[a] = new Set();
        if (!conflict[b]) conflict[b] = new Set();
        conflict[a].add(b);
        conflict[b].add(a);
      }
    }
  }
  return conflict;
}

/**
 * 2-color the conflict subgraph induced on `members` (BFS per component).
 * Returns a hand map (0/1) on success, or the offending same-color pair on
 * failure. With `handsPerPlayer <= 1` any edge at all is a failure — the
 * group must be a plain independent set, i.e. today's strict behavior.
 */
function twoColor(
  members: string[],
  conflict: Record<string, Set<string>>,
  handsPerPlayer = 2,
): Map<string, 0 | 1> | [string, string] {
  if (handsPerPlayer <= 1) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (conflict[members[i]]?.has(members[j])) return [members[i], members[j]];
      }
    }
    return new Map(members.map(m => [m, 0 as const]));
  }

  const color = new Map<string, 0 | 1>();
  const memberSet = new Set(members);
  for (const start of members) {
    if (color.has(start)) continue;
    color.set(start, 0);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const nb of conflict[cur] ?? []) {
        if (!memberSet.has(nb)) continue;
        if (!color.has(nb)) {
          color.set(nb, color.get(cur) === 0 ? 1 : 0);
          queue.push(nb);
        } else if (color.get(nb) === color.get(cur)) {
          return [cur, nb];
        }
      }
    }
  }
  return color;
}

/**
 * Best-effort variant of `twoColor` that never fails: same-color conflicts
 * (odd cycles) are simply left in place rather than reported. Used only to
 * produce a hand map for the best-effort fallback assignment.
 */
function colorGroupBestEffort(
  members: string[],
  conflict: Record<string, Set<string>>,
  handsPerPlayer: number,
): Map<string, 0 | 1> {
  if (handsPerPlayer <= 1) return new Map(members.map(m => [m, 0 as const]));
  const color = new Map<string, 0 | 1>();
  const memberSet = new Set(members);
  for (const start of members) {
    if (color.has(start)) continue;
    color.set(start, 0);
    const queue = [start];
    while (queue.length) {
      const cur = queue.shift()!;
      for (const nb of conflict[cur] ?? []) {
        if (!memberSet.has(nb) || color.has(nb)) continue;
        color.set(nb, color.get(cur) === 0 ? 1 : 0);
        queue.push(nb);
      }
    }
  }
  return color;
}

/**
 * Final per-player hand map, applying the "lowest-pitch bell is hand 0"
 * convention. Falls back to a best-effort coloring when a group isn't
 * actually 2-colorable (only reachable via the best-effort fallback path).
 */
function computeHands(
  membersByGroup: Map<number, string[]>,
  conflict: Record<string, Set<string>>,
  handsPerPlayer: number,
  pos: Map<string, number>,
): Record<string, number> {
  const hands: Record<string, number> = {};
  for (const members of membersByGroup.values()) {
    if (!members.length) continue;
    const result = twoColor(members, conflict, handsPerPlayer);
    const coloring = Array.isArray(result)
      ? colorGroupBestEffort(members, conflict, handsPerPlayer)
      : result;
    const lowest = members.reduce((a, b) => (pos.get(a)! < pos.get(b)! ? a : b));
    const flip = coloring.get(lowest) === 1;
    for (const m of members) {
      const c = coloring.get(m) ?? 0;
      hands[m] = flip ? (c === 0 ? 1 : 0) : c;
    }
  }
  return hands;
}

function optimalContiguousPartition(weights: number[], k: number): number[] {
  const n = weights.length;
  const prefix = new Array(n + 1).fill(0);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + weights[i];
  const segSum = (a: number, b: number) => prefix[b] - prefix[a];

  const INF = Infinity;
  // dp[i][j] = [bestMax, bestMin] for first i items in j groups
  const dp: [number, number][][] = Array.from({ length: n + 1 }, () =>
    Array(k + 1).fill([INF, -INF]));
  const parent: number[][] = Array.from({ length: n + 1 }, () =>
    Array(k + 1).fill(-1));
  dp[0][0] = [0, INF];

  for (let j = 1; j <= k; j++) {
    for (let i = j; i <= n - (k - j); i++) {
      let best: [number, number] = [INF, -INF];
      let bestM = -1;
      for (let m = j - 1; m < i; m++) {
        const [prevMax, prevMin] = dp[m][j - 1];
        if (prevMax === INF) continue;
        const s = segSum(m, i);
        const cand: [number, number] = [Math.max(prevMax, s), Math.min(prevMin, s)];
        // Compare (cand[0], -cand[1]) < (best[0], -best[1])
        if (cand[0] < best[0] || (cand[0] === best[0] && -cand[1] < -best[1])) {
          best = cand;
          bestM = m;
        }
      }
      dp[i][j] = best;
      parent[i][j] = bestM;
    }
  }

  const groups = new Array(n).fill(0);
  let i = n, j = k, gid = k - 1;
  while (j > 0) {
    const m = parent[i][j];
    for (let idx = m; idx < i; idx++) groups[idx] = gid;
    i = m; j--; gid--;
  }
  return groups;
}

function boundariesFromGroups(groups: number[]): number[] {
  const b = [0];
  let current = groups[0];
  for (let i = 1; i < groups.length; i++) {
    if (groups[i] !== current) { b.push(i); current = groups[i]; }
  }
  b.push(groups.length);
  return b;
}

function groupsFromBoundaries(boundaries: number[], n: number): number[] {
  const groups = new Array(n).fill(0);
  for (let gid = 0; gid < boundaries.length - 1; gid++) {
    for (let idx = boundaries[gid]; idx < boundaries[gid + 1]; idx++) {
      groups[idx] = gid;
    }
  }
  return groups;
}

function perturbBoundaries(boundaries: number[], rng: SeededRandom, steps: number): number[] {
  const b = [...boundaries];
  const k = b.length;
  for (let s = 0; s < steps; s++) {
    if (k <= 2) break;
    const i = rng.randint(k - 2) + 1;
    const nb = b[i] + rng.choice([-1, 1]);
    if (nb > b[i - 1] && nb < b[i + 1]) b[i] = nb;
  }
  return b;
}

function calcPitchCost(membersByGroup: Map<number, string[]>, pos: Map<string, number>): number {
  let total = 0;
  for (const members of membersByGroup.values()) {
    if (members.length === 0) continue;
    const positions = members.map(n => pos.get(n)!);
    total += Math.max(...positions) - Math.min(...positions);
  }
  return total;
}

function findBestTarget(
  note: string,
  excludeGid: number,
  membersByGroup: Map<number, string[]>,
  conflict: Record<string, Set<string>>,
  pos: Map<string, number>,
  sums: Map<number, number>,
  handsPerPlayer: number,
): [number, number] | null {
  const notePos = pos.get(note)!;
  let best: [[number, number], number] | null = null;

  for (const [gid, members] of membersByGroup) {
    if (gid === excludeGid) continue;
    if (Array.isArray(twoColor([...members, note], conflict, handsPerPlayer))) continue;
    const positions = members.map(m => pos.get(m)!);
    const before = positions.length ? Math.max(...positions) - Math.min(...positions) : 0;
    const afterPositions = [...positions, notePos];
    const after = Math.max(...afterPositions) - Math.min(...afterPositions);
    const delta = after - before;
    const key: [number, number] = [delta, sums.get(gid)!];
    if (!best || key[0] < best[0][0] || (key[0] === best[0][0] && key[1] < best[0][1])) {
      best = [key, gid];
    }
  }
  return best ? [best[1], best[0][0]] : null;
}

function repairConflicts(
  order: string[],
  groups: number[],
  conflict: Record<string, Set<string>>,
  pos: Map<string, number>,
  counts: Map<string, number>,
  rng: SeededRandom,
  pinned: Set<string>,
  handsPerPlayer: number,
): number[] | null {
  const assignment = new Map<string, number>(order.map((n, i) => [n, groups[i]]));

  for (let iter = 0; iter < order.length * 10 + 50; iter++) {
    const membersByGroup = new Map<number, string[]>();
    for (const [n, g] of assignment) {
      if (!membersByGroup.has(g)) membersByGroup.set(g, []);
      membersByGroup.get(g)!.push(n);
    }

    let conflictingPair: [number, string, string] | null = null;
    const groupIds = [...membersByGroup.keys()];
    rng.shuffle(groupIds);
    for (const gid of groupIds) {
      const members = membersByGroup.get(gid)!;
      const result = twoColor(members, conflict, handsPerPlayer);
      if (Array.isArray(result)) {
        conflictingPair = [gid, result[0], result[1]];
        break;
      }
    }
    if (!conflictingPair) return order.map(n => assignment.get(n)!);

    const [gid, a, b] = conflictingPair;
    const sums = new Map<number, number>();
    for (const [g, members] of membersByGroup) {
      sums.set(g, members.reduce((s, n) => s + counts.get(n)!, 0));
    }

    const options: [number, number, string, number][] = [];
    for (const noteToMove of [a, b]) {
      if (pinned.has(noteToMove)) continue;
      const target = findBestTarget(noteToMove, gid, membersByGroup, conflict, pos, sums, handsPerPlayer);
      if (target) {
        const [targetGid, delta] = target;
        options.push([delta, counts.get(noteToMove)!, noteToMove, targetGid]);
      }
    }
    if (!options.length) return null;

    rng.shuffle(options);
    options.sort((x, y) => x[0] !== y[0] ? x[0] - y[0] : x[1] - y[1]);
    const [, , noteToMove, targetGid] = options[0];
    assignment.set(noteToMove, targetGid);
  }
  return null;
}

function findDonorFor(
  targetGid: number,
  membersByGroup: Map<number, string[]>,
  conflict: Record<string, Set<string>>,
  pos: Map<string, number>,
  counts: Map<string, number>,
  pinned: Set<string>,
  minCount: number,
  handsPerPlayer: number,
): [string, number] | null {
  const targetMembers = membersByGroup.get(targetGid) ?? [];
  const targetPositions = targetMembers.map(m => pos.get(m)!);
  const before = targetPositions.length ? Math.max(...targetPositions) - Math.min(...targetPositions) : 0;

  let best: [[boolean, number, number], string, number] | null = null;

  for (const [gid, members] of membersByGroup) {
    if (gid === targetGid) continue;
    const sourceSum = members.reduce((s, m) => s + counts.get(m)!, 0);
    for (const note of members) {
      if (pinned.has(note)) continue;
      if (Array.isArray(twoColor([...targetMembers, note], conflict, handsPerPlayer))) continue;
      const afterPositions = [...targetPositions, pos.get(note)!];
      const after = Math.max(...afterPositions) - Math.min(...afterPositions);
      const delta = after - before;
      const starvesDonor = (sourceSum - counts.get(note)!) < minCount;
      const key: [boolean, number, number] = [starvesDonor, delta, -sourceSum];
      if (!best || key[0] < best[0][0] ||
          (key[0] === best[0][0] && key[1] < best[0][1]) ||
          (key[0] === best[0][0] && key[1] === best[0][1] && key[2] < best[0][2])) {
        best = [key, note, gid];
      }
    }
  }
  return best ? [best[1], best[2]] : null;
}

function bumpToMinimum(
  order: string[],
  groups: number[],
  conflict: Record<string, Set<string>>,
  pos: Map<string, number>,
  counts: Map<string, number>,
  nPlayers: number,
  minCount: number,
  pinned: Set<string>,
  handsPerPlayer: number,
): number[] | null {
  const assignment = new Map<string, number>(order.map((n, i) => [n, groups[i]]));

  for (let iter = 0; iter < order.length * 5 + 50; iter++) {
    const membersByGroup = new Map<number, string[]>();
    for (let g = 0; g < nPlayers; g++) membersByGroup.set(g, []);
    for (const n of order) membersByGroup.get(assignment.get(n)!)!.push(n);

    const sums = new Map<number, number>();
    for (const [g, members] of membersByGroup) {
      sums.set(g, members.reduce((s, n) => s + counts.get(n)!, 0));
    }

    const under = [...sums.entries()].filter(([, s]) => s < minCount).map(([g]) => g);
    if (!under.length) return order.map(n => assignment.get(n)!);

    const targetGid = under.reduce((a, b) => sums.get(a)! < sums.get(b)! ? a : b);
    const found = findDonorFor(targetGid, membersByGroup, conflict, pos, counts, pinned, minCount, handsPerPlayer);
    if (!found) return null;
    const [note] = found;
    assignment.set(note, targetGid);
  }
  return null;
}

export interface AssignOptions {
  pins?: Record<string, number>;
  playerNames?: string[];
  minCount?: number;
  minGapBeats?: number;
  division?: number;
  attempts?: number;
  seed?: number;
  handsPerPlayer?: number;
}

export function assignPlayers(events: NoteEvent[], nPlayers: number, opts: AssignOptions = {}): Assignment {
  const { pins = {}, playerNames = null, minCount = null, minGapBeats = null,
          division = 480, attempts = 150, seed = 0 } = opts;
  const handsPerPlayer = Math.max(1, opts.handsPerPlayer ?? 2);

  const counts = new Map<string, number>();
  const midi = new Map<string, number>();
  for (const e of events) {
    counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
    midi.set(e.name, e.midi);
  }

  const allNotes = [...counts.keys()].sort((a, b) => (midi.get(a) ?? 0) - (midi.get(b) ?? 0));
  if (nPlayers < 1) throw new Error('nPlayers must be >= 1');
  if (nPlayers > allNotes.length) {
    throw new Error(
      `Requested ${nPlayers} players but the score only has ${allNotes.length} distinct notes.`
    );
  }

  if (minGapBeats !== null && minGapBeats < 0) {
    throw new Error("Minimum gap between bells can't be negative.");
  }
  const minGapTicks = minGapBeats ? Math.round(minGapBeats * division) : 0;

  const pos = new Map<string, number>(allNotes.map((n, i) => [n, i]));
  const conflict = buildConflictGraph(events, minGapTicks);

  const pinnedNotes = new Set(Object.keys(pins));
  for (const [note, playerIdx] of Object.entries(pins)) {
    if (!pos.has(note)) throw new Error(`'${note}' isn't a bell used in this score, so it can't be pinned.`);
    if (playerIdx < 0 || playerIdx >= nPlayers) {
      throw new Error(`Can't pin ${note} to player ${playerIdx + 1} — there are only ${nPlayers} players.`);
    }
  }

  if (minCount !== null) {
    if (minCount < 0) throw new Error("Minimum strikes per player can't be negative.");
    const totalStrikes = [...counts.values()].reduce((a, b) => a + b, 0);
    if (minCount * nPlayers > totalStrikes) {
      throw new Error(
        `Can't guarantee ${minCount} strikes per player across ${nPlayers} players — ` +
        `the score only has ${totalStrikes} strikes total (${(totalStrikes / nPlayers).toFixed(1)} on average).`
      );
    }
  }

  const weights = allNotes.map(n => counts.get(n)!);
  const baseGroups = optimalContiguousPartition(weights, nPlayers);
  const baseBoundaries = boundariesFromGroups(baseGroups);

  const rng = new SeededRandom(seed);
  let best: [[number, number], Map<number, string[]>, Map<number, number>, number, number] | null = null;

  for (let attemptI = 0; attemptI < attempts; attemptI++) {
    const steps = attemptI === 0 ? 0 : Math.min(attemptI, baseBoundaries.length);
    const boundaries = perturbBoundaries(baseBoundaries, rng, steps);
    const attemptGroups = groupsFromBoundaries(boundaries, allNotes.length);

    for (const [note, playerIdx] of Object.entries(pins)) {
      attemptGroups[pos.get(note)!] = playerIdx;
    }

    let repaired = repairConflicts(allNotes, attemptGroups, conflict, pos, counts, rng, pinnedNotes, handsPerPlayer);
    if (!repaired) continue;

    if (minCount !== null) {
      const bumped = bumpToMinimum(allNotes, repaired, conflict, pos, counts, nPlayers, minCount, pinnedNotes, handsPerPlayer);
      if (!bumped) continue;
      repaired = bumped;
    }

    const membersByGroup = new Map<number, string[]>();
    for (const [n, g] of allNotes.map((n, i) => [n, repaired![i]] as [string, number])) {
      if (!membersByGroup.has(g)) membersByGroup.set(g, []);
      membersByGroup.get(g)!.push(n);
    }

    const sums = new Map<number, number>();
    for (const [g, members] of membersByGroup) {
      sums.set(g, members.reduce((s, n) => s + counts.get(n)!, 0));
    }
    const pitchCost = calcPitchCost(membersByGroup, pos);
    const sumVals = [...sums.values()];
    const spread = Math.max(...sumVals) - Math.min(...sumVals);
    const score: [number, number] = [pitchCost, spread];

    if (!best || score[0] < best[0][0] || (score[0] === best[0][0] && score[1] < best[0][1])) {
      best = [score, membersByGroup, sums, pitchCost, spread];
    }
  }

  const conflictSerializable: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(conflict)) {
    conflictSerializable[k] = [...v];
  }

  if (!best) {
    // No conflict-free arrangement found. Return a best-effort fallback using
    // the base contiguous partition so the user can see where conflicts arise.
    const fallbackGroups = [...baseGroups];
    for (const [note, playerIdx] of Object.entries(pins)) {
      fallbackGroups[pos.get(note)!] = playerIdx;
    }
    const fallbackMembers = new Map<number, string[]>();
    for (let g = 0; g < nPlayers; g++) fallbackMembers.set(g, []);
    for (let i = 0; i < allNotes.length; i++) {
      fallbackMembers.get(fallbackGroups[i])!.push(allNotes[i]);
    }
    const fallbackSums = new Map<number, number>();
    for (const [g, members] of fallbackMembers) {
      fallbackSums.set(g, members.reduce((s, n) => s + counts.get(n)!, 0));
    }
    const fallbackPitchCost = calcPitchCost(fallbackMembers, pos);
    const fallbackSumVals = [...fallbackSums.values()];
    const fallbackSpread = Math.max(...fallbackSumVals) - Math.min(...fallbackSumVals);

    const fallbackPlayers: string[][] = [];
    const fallbackPlayerSums: number[] = [];
    for (let gid = 0; gid < nPlayers; gid++) {
      const members = (fallbackMembers.get(gid) ?? []).sort((a, b) => (midi.get(a) ?? 0) - (midi.get(b) ?? 0));
      fallbackPlayers.push(members);
      fallbackPlayerSums.push(fallbackSums.get(gid) ?? 0);
    }

    return {
      players: fallbackPlayers,
      playerSums: fallbackPlayerSums,
      spread: fallbackSpread,
      counts: Object.fromEntries(counts),
      pitchCost: fallbackPitchCost,
      conflicts: conflictSerializable,
      playerNames: playerNames ?? null,
      pinned: pins,
      minCount: minCount ?? null,
      minGapBeats: minGapBeats ?? null,
      handsPerPlayer,
      hands: computeHands(fallbackMembers, conflict, handsPerPlayer, pos),
      hasConflicts: true,
    };
  }

  const [, membersByGroup, sums, pitchCost, spread] = best;

  const players: string[][] = [];
  const playerSums: number[] = [];
  for (let gid = 0; gid < nPlayers; gid++) {
    const members = (membersByGroup.get(gid) ?? []).sort((a, b) => (midi.get(a) ?? 0) - (midi.get(b) ?? 0));
    players.push(members);
    playerSums.push(sums.get(gid) ?? 0);
  }

  return {
    players,
    playerSums,
    spread,
    counts: Object.fromEntries(counts),
    pitchCost,
    conflicts: conflictSerializable,
    playerNames: playerNames ?? null,
    pinned: pins,
    minCount: minCount ?? null,
    minGapBeats: minGapBeats ?? null,
    handsPerPlayer,
    hands: computeHands(membersByGroup, conflict, handsPerPlayer, pos),
    hasConflicts: false,
  };
}
