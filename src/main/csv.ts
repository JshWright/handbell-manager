import { Assignment } from '../core/assigner';

export function buildCsv(assignment: Assignment): string {
  const names = assignment.playerNames ?? assignment.players.map((_, i) => `Player ${i + 1}`);
  const rows: string[] = ['Player,Name,Bell,Hand,Count,Player Total,Pinned'];
  for (let i = 0; i < assignment.players.length; i++) {
    for (const bell of assignment.players[i]) {
      const pinned = assignment.pinned[bell] === i ? 'yes' : '';
      const hand = assignment.hands?.[bell] === 1 ? 'R' : 'L';
      rows.push(
        [`P${i + 1}`, names[i], bell, hand, assignment.counts[bell], assignment.playerSums[i], pinned].join(',')
      );
    }
  }
  return rows.join('\n') + '\n';
}
