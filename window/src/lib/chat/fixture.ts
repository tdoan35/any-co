// S14 (ANY-64): scripted Dana is retired — the one-response chat path, its fixture flag and the
// Ctrl+Shift+F hotkey are gone (RUNTIME §14). Nothing can arm a scripted turn anymore: every
// export below is an inert stub that exists only so the chat components (outside this card's
// file scope, unchanged) keep typechecking. The hotkey predicate never matches, the toggles are
// no-ops, and the armed state is always false, so the "Scripted next turn" chip never renders.
// A card that owns apps/web/src/components/chat deletes those imports and this module together.
export const toggleFixture = () => {};
export const disarmFixture = () => {};
export const useFixtureArmed = (): boolean => false;
export const isFixtureHotkey = (event: KeyboardEvent): boolean => {
  void event; // the hotkey is retired: no key combination matches anymore
  return false;
};
