import { SCREEN } from './netRevealJourney';
import type { Measurement } from './types';

/** Only an explicit role skip of All Alerts exempts its dependent actions. */
export function missingCatalogueScreens(
  measurements: readonly Measurement[],
  users: readonly string[],
  allAlertsMenuPath: string,
): string[] {
  return users.flatMap((user) => {
    const recorded = measurements.filter((m) => m.user === user);
    const allAlerts = recorded.filter((m) => m.screen === SCREEN.menu(allAlertsMenuPath));
    const unavailable = allAlerts.length > 0 &&
      allAlerts.every((m) => m.status === 'skipped' && m.skipReason === 'role');
    const required = unavailable
      ? [SCREEN.login]
      : [SCREEN.login, SCREEN.allAlertsSearch, SCREEN.alertDetailsOpen];
    return required
      .filter((screen) => !recorded.some((m) => m.screen === screen && m.status === 'ok'))
      .map((screen) => `${user}: ${screen}`);
  });
}
