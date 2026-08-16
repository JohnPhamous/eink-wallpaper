import os from 'node:os';
import path from 'node:path';

const home = os.homedir();

export const paths = {
  support: path.join(home, 'Library', 'Application Support', 'Eink Wallpaper'),
  config: path.join(home, 'Library', 'Application Support', 'Eink Wallpaper', 'config.json'),
  state: path.join(home, 'Library', 'Application Support', 'Eink Wallpaper', 'state.json'),
  editions: path.join(home, 'Library', 'Application Support', 'Eink Wallpaper', 'editions'),
  candidates: path.join(home, 'Library', 'Application Support', 'Eink Wallpaper', 'candidates'),
  archives: path.join(home, 'Library', 'Application Support', 'Eink Wallpaper', 'archives'),
  cache: path.join(home, 'Library', 'Application Support', 'Eink Wallpaper', 'cache'),
  logs: path.join(home, 'Library', 'Logs', 'Eink Wallpaper'),
  launchAgent: path.join(home, 'Library', 'LaunchAgents', 'com.phamous.eink-wallpaper.plist'),
};

export const KEYCHAIN_SERVICE = 'com.phamous.eink-wallpaper';
