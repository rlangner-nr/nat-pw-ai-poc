import type { Page } from '@playwright/test';
import { BasePage } from './BasePage';

export class LoginPage extends BasePage {
  readonly usernameSelector = '#forms-text-field-username';
  readonly passwordSelector = '#forms-text-field-password';
  readonly submitSelector = 'button.btn.btn-success.btn-block[type="submit"]';

  constructor(page: Page) {
    super(page);
  }

  /** Assumes the login URL is already opened (baseURL / resolveBaseUrl). */
  async open(): Promise<Page> {
    return this.page;
  }

  async login(username: string, password: string, timeoutMs?: number): Promise<void> {
    if (timeoutMs !== undefined) {
      const deadline = Date.now() + timeoutMs;
      const remaining = () => {
        const ms = deadline - Date.now();
        if (ms <= 0) throw new Error('Login form submission timed out');
        return ms;
      };
      await this.page.fill(this.usernameSelector, username, { timeout: remaining() });
      await this.page.fill(this.passwordSelector, password, { timeout: remaining() });
      await this.page.click(this.submitSelector, { timeout: remaining() });
      return;
    }
    await this.fill(this.usernameSelector, username);
    await this.fill(this.passwordSelector, password);
    await this.click(this.submitSelector);
  }

  /** Migrated from NAT LoginPage.getLoginButtonText() assertion. */
  async assertOnLoginPage(timeout = 15000): Promise<true> {
    const deadline = Date.now() + timeout;
    await this.waitForVisible(this.submitSelector, timeout);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Login page did not become ready in time');
    const text = (await this.page.textContent(this.submitSelector, { timeout: remaining }) || '').trim();
    if (!text.includes('Login')) {
      throw new Error(`Expected login button text to contain "Login", got: "${text}"`);
    }
    return true;
  }
}
