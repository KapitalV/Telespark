export const BOARD_KEYBOARD={keyboard:[['UP BOARD','CBSE BOARD']],resize_keyboard:true,one_time_keyboard:true};
export function boardName(value) {
  const name=String(value).trim().toUpperCase().replace(/\s+/g,' ');
  if (/^UP(?: BOARD)?$/.test(name)) return 'UP BOARD';
  if (/^CBS[EC](?: BOARD)?$/.test(name)) return 'CBSE';
  return name;
}
