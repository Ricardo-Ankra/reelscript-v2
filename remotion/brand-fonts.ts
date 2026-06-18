// Loads every brand-allowlisted font before the first frame so a spec's
// theme.fonts value resolves in the CSS. MUST stay in sync with FONT_ALLOWLIST
// in src/lib/channels/fonts.ts — fonts.test.ts asserts every allowlisted family
// has its loadFont import here. (This file can't import that list: it pulls
// @remotion/google-fonts, which the node:test loader can't load.)
import { loadFont as loadPoppins } from '@remotion/google-fonts/Poppins';
import { loadFont as loadMontserrat } from '@remotion/google-fonts/Montserrat';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { loadFont as loadRoboto } from '@remotion/google-fonts/Roboto';
import { loadFont as loadPlayfairDisplay } from '@remotion/google-fonts/PlayfairDisplay';
import { loadFont as loadBebasNeue } from '@remotion/google-fonts/BebasNeue';

loadPoppins();
loadMontserrat();
loadInter();
loadRoboto();
loadPlayfairDisplay();
loadBebasNeue();
