// Single source of truth for the LimeZu character spritesheets used by
// both Phaser (NPC sprites) and the DOM email list (avatar chips).
// Each sheet is 4 cols × 8 rows of 32×32 frames.

export interface CharacterDef {
  key: string;          // Phaser texture key (registered in main.ts preload)
  file: string;         // Path relative to public/assets/characters/
}

export const CHARACTERS: CharacterDef[] = [
  { key: 'char_knight',         file: 'Knight/knight.png' },
  { key: 'char_chef',           file: 'Chef/chef.png' },
  { key: 'char_farmer',         file: 'Farmer/farmer.png' },
  { key: 'char_old_man',        file: 'Old Man/old_man.png' },
  { key: 'char_old_woman',      file: 'Old Woman/old_woman.png' },
  { key: 'char_blonde_man',     file: 'Blonde Man/blonde_man.png' },
  { key: 'char_blonde_woman',   file: 'Blonde Woman/blonde_woman.png' },
  { key: 'char_punk_man',       file: 'Punk Man/punk_men.png' },
  { key: 'char_punk_woman',     file: 'Punk Woman/punk_woman.png' },
  { key: 'char_viking_man',     file: 'Viking Man/viking_man.png' },
  { key: 'char_viking_woman',   file: 'Viking Woman/viking_woman.png' },
  { key: 'char_businessman',    file: 'Businessman/businessman.png' },
  { key: 'char_policeman',      file: 'Policeman/policeman.png' },
  { key: 'char_firefighter',    file: 'Firefighter/firefighter.png' },
  { key: 'char_nun',            file: 'Nun/nun.png' },
  { key: 'char_soldier',        file: 'Soldier/soldier.png' },
];

// Deterministic mapping from any string (sender email) to a character.
// Same sender → same avatar across views, so visual identity is stable.
export function characterForKey(seed: string): CharacterDef {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return CHARACTERS[Math.abs(hash) % CHARACTERS.length];
}
