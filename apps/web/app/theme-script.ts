/** Theme persistence shared by the server layout (boot script) and the client toggle. */
export const THEME_STORAGE_KEY = 'soltrader-theme';

/**
 * Runs before the first paint (inline in <head>) so the stored theme applies without a light/dark flash.
 * Default is the dark theme (trading terminal); an explicit choice is remembered per browser.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t!=='dark'&&t!=='light')t='dark';document.documentElement.setAttribute('data-theme',t);}catch(e){document.documentElement.setAttribute('data-theme','dark');}})();`;

