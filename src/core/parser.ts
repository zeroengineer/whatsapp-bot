export type ConfirmToken = 'CONFIRM' | 'CONFIRM REMOVEALL' | 'CONFIRM LEAVE';

export interface ParsedCommand {
  name: string;
  /** Argument string with flags removed and whitespace collapsed. */
  args: string;
  dryRun: boolean;
}

export type ParsedInput =
  | { kind: 'command'; command: ParsedCommand }
  | { kind: 'confirm'; token: ConfirmToken }
  | { kind: 'none' };

const DRY_RUN_FLAG = /(^|\s)--dry-?run(?=\s|$)/gi;

/**
 * Parse an incoming text. Confirmation tokens must be typed exactly (uppercase) so that
 * casual text like "confirm?" never triggers a destructive operation.
 */
export function parseInput(text: string, prefix: string): ParsedInput {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (trimmed === 'CONFIRM' || trimmed === 'CONFIRM REMOVEALL' || trimmed === 'CONFIRM LEAVE') {
    return { kind: 'confirm', token: trimmed };
  }
  if (!trimmed.startsWith(prefix)) return { kind: 'none' };

  const body = trimmed.slice(prefix.length);
  const match = /^([a-zA-Z]+)(?:\s+(.*))?$/.exec(body);
  if (!match?.[1]) return { kind: 'none' };

  const rawArgs = match[2] ?? '';
  const dryRun = DRY_RUN_FLAG.test(rawArgs);
  DRY_RUN_FLAG.lastIndex = 0;
  const args = rawArgs.replace(DRY_RUN_FLAG, ' ').replace(/\s+/g, ' ').trim();
  return { kind: 'command', command: { name: match[1].toLowerCase(), args, dryRun } };
}

export class IndexSpecError extends Error {}

const MAX_SELECTION = 5000;

/**
 * Parse member index selections: "1,3,4", "1 3 4", "2-6", "1, 3-5 ,9".
 * Returns unique indexes in ascending order. Throws IndexSpecError on invalid input.
 */
export function parseIndexSpec(spec: string): number[] {
  const parts = spec
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) throw new IndexSpecError('No member numbers given.');

  const out = new Set<number>();
  for (const part of parts) {
    const range = /^(\d+)-(\d+)$/.exec(part);
    if (range) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a < 1 || b < a) throw new IndexSpecError(`Invalid range "${part}".`);
      if (b - a + 1 > MAX_SELECTION) throw new IndexSpecError(`Range "${part}" is too large.`);
      for (let i = a; i <= b; i++) out.add(i);
    } else if (/^\d+$/.test(part)) {
      const n = Number(part);
      if (n < 1) throw new IndexSpecError(`Invalid member number "${part}".`);
      out.add(n);
    } else {
      throw new IndexSpecError(`Invalid member number "${part}".`);
    }
    if (out.size > MAX_SELECTION) throw new IndexSpecError('Too many members selected.');
  }
  return [...out].sort((x, y) => x - y);
}

const INDEX_TOKEN = /^[\d,-]+$/;

export interface GroupAndIndexSplit {
  groupQuery: string;
  indexSpec: string;
}

/**
 * Split "<group> <indexes>" into candidate (group, indexes) pairs.
 *
 * Group names may themselves end in numbers ("Batch 2024 1,3"), so every split of the trailing
 * numeric tokens is returned, preferring the longest group name first. A quoted group name
 * ("Batch 2024" 1,3) yields exactly one split.
 */
export function splitGroupAndIndexes(args: string): GroupAndIndexSplit[] {
  const quoted = /^"([^"]+)"\s+(.+)$/.exec(args.trim());
  if (quoted?.[1] && quoted[2]) return [{ groupQuery: quoted[1].trim(), indexSpec: quoted[2].trim() }];

  const tokens = args.trim().split(/\s+/).filter(Boolean);
  let firstIndexToken = tokens.length;
  while (firstIndexToken > 1 && INDEX_TOKEN.test(tokens[firstIndexToken - 1] ?? '')) firstIndexToken--;

  const splits: GroupAndIndexSplit[] = [];
  // At least one token must remain for the group, and at least one for the indexes.
  for (let cut = tokens.length - 1; cut >= Math.max(firstIndexToken, 1); cut--) {
    splits.push({ groupQuery: tokens.slice(0, cut).join(' '), indexSpec: tokens.slice(cut).join(' ') });
  }
  return splits;
}

export type GroupSelection =
  | { kind: 'single'; query: string }
  | { kind: 'numbers'; indexes: number[] }
  | { kind: 'names'; names: string[] };

/**
 * Parse a group selection for commands that accept several groups:
 *   "College Group" | "3"            → single
 *   "1,3,7" | "1 3 7" | "1-4"         → numbers (more than one group)
 *   "College Group | Project Team"    → names
 * Throws IndexSpecError for malformed number lists.
 */
export function parseGroupSelection(args: string): GroupSelection {
  const trimmed = args.trim();
  if (trimmed.includes('|')) {
    const names = trimmed
      .split('|')
      .map((n) => unquote(n))
      .filter(Boolean);
    if (names.length === 1 && names[0]) return { kind: 'single', query: names[0] };
    return { kind: 'names', names };
  }
  if (/^[\d,\s-]+$/.test(trimmed) && /[,\s-]/.test(trimmed)) {
    const indexes = parseIndexSpec(trimmed);
    if (indexes.length > 1) return { kind: 'numbers', indexes };
    return { kind: 'single', query: String(indexes[0]) };
  }
  return { kind: 'single', query: unquote(trimmed) };
}

/** Strip optional surrounding quotes from a group argument. */
export function unquote(arg: string): string {
  const m = /^"([^"]+)"$/.exec(arg.trim());
  return (m?.[1] ?? arg).trim();
}
