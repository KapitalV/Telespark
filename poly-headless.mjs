export function createPolyHeadlessResolver(env=process.env) {
  let showOneVisibleSession=env.OTNEW_POLY_VISIBLE_ONCE==='true';
  return () => {
    if(showOneVisibleSession) {showOneVisibleSession=false;return false;}
    return env.HEADLESS!=='false';
  };
}
