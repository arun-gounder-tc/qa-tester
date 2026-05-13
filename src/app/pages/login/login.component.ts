import { ChangeDetectionStrategy, Component, OnDestroy, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  CheckCircle2,
  Copy,
  ExternalLink,
  Github,
  LucideAngularModule,
  TestTube2,
} from 'lucide-angular';
import { AnimatedBackgroundComponent } from '../../components/shared/animated-background/animated-background.component';
import { ButtonComponent } from '../../components/shared/button/button.component';
import { DeviceCode, TauriBridgeService } from '../../services/api/tauri-bridge.service';
import { GithubService } from '../../services/api/github.service';
import { AuthStore } from '../../services/state/auth.store';
import { NotificationService } from '../../services/utils/notification.service';

type Phase = 'idle' | 'requesting' | 'waiting' | 'success' | 'error';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [
    ButtonComponent,
    LucideAngularModule,
    AnimatedBackgroundComponent,
  ],
  templateUrl: './login.component.html',
  styleUrl: './login.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginComponent implements OnDestroy {
  private tauri = inject(TauriBridgeService);
  private github = inject(GithubService);
  private auth = inject(AuthStore);
  private notify = inject(NotificationService);
  private router = inject(Router);

  readonly LogoIcon = TestTube2;
  readonly GithubIcon = Github;
  readonly ExternalIcon = ExternalLink;
  readonly CopyIcon = Copy;
  readonly CheckCircleIcon = CheckCircle2;

  readonly isTauri = this.tauri.isTauri;
  readonly phase = signal<Phase>('idle');
  readonly deviceCode = signal<DeviceCode | null>(null);
  readonly errorMsg = signal<string | null>(null);
  readonly codeCopied = signal(false);
  readonly successName = signal<string>('');

  readonly userCodeDisplay = computed(() => this.deviceCode()?.user_code ?? '');

  private pollTimeoutId: number | null = null;
  private expiryTimeoutId: number | null = null;

  ngOnDestroy(): void {
    this.clearTimers();
  }

  async onSignIn(): Promise<void> {
    if (!this.isTauri) {
      this.errorMsg.set('Sign-in requires the desktop app. Run: npm run tauri:dev');
      return;
    }
    this.phase.set('requesting');
    this.errorMsg.set(null);
    try {
      const code = await this.tauri.startDeviceFlow();
      this.deviceCode.set(code);
      this.phase.set('waiting');

      await this.tauri.openExternal(code.verification_uri);
      this.notify.info('Browser opened. Enter the code shown here.');

      this.scheduleExpiry(code.expires_in);
      this.scheduleNextPoll(code.device_code, code.interval);
    } catch (err) {
      this.deviceCode.set(null);
      this.phase.set('error');
      this.errorMsg.set(this.formatError(err));
    }
  }

  async copyCode(): Promise<void> {
    const code = this.userCodeDisplay();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      this.codeCopied.set(true);
      setTimeout(() => this.codeCopied.set(false), 1500);
    } catch {
      this.notify.error('Copy failed. Select and copy manually.');
    }
  }

  async openBrowserAgain(): Promise<void> {
    const code = this.deviceCode();
    if (!code) return;
    await this.tauri.openExternal(code.verification_uri);
  }

  cancel(): void {
    this.clearTimers();
    this.deviceCode.set(null);
    this.phase.set('idle');
    this.errorMsg.set(null);
  }

  private scheduleNextPoll(deviceCode: string, intervalSec: number): void {
    this.pollTimeoutId = window.setTimeout(
      () => this.poll(deviceCode, intervalSec),
      intervalSec * 1000,
    );
  }

  private async poll(deviceCode: string, intervalSec: number): Promise<void> {
    if (this.phase() !== 'waiting') return;
    try {
      const result = await this.tauri.pollForToken(deviceCode);

      switch (result.status) {
        case 'authorized':
          this.clearTimers();
          await this.completeSignIn(result.access_token);
          return;
        case 'pending':
          this.scheduleNextPoll(deviceCode, intervalSec);
          return;
        case 'slow-down':
          this.scheduleNextPoll(deviceCode, intervalSec + 5);
          return;
        case 'expired':
          this.clearTimers();
          this.deviceCode.set(null);
          this.phase.set('error');
          this.errorMsg.set('Code expired. Please try signing in again.');
          return;
        case 'denied':
          this.clearTimers();
          this.deviceCode.set(null);
          this.phase.set('error');
          this.errorMsg.set('Authorization denied.');
          return;
      }
    } catch (err) {
      this.clearTimers();
      this.deviceCode.set(null);
      this.phase.set('error');
      this.errorMsg.set(this.formatError(err));
    }
  }

  private async completeSignIn(token: string): Promise<void> {
    try {
      const user = await this.github.fetchUser(token);
      const displayName = user.name ?? user.login;
      this.auth.setSession(
        {
          login: user.login,
          name: displayName,
          avatarUrl: user.avatar_url,
        },
        token,
      );
      this.successName.set(displayName);
      this.phase.set('success');
      setTimeout(() => {
        void this.router.navigate(['/projects']);
      }, 1600);
    } catch (err) {
      this.phase.set('error');
      this.errorMsg.set('Could not fetch your profile. Try again.');
    }
  }

  private scheduleExpiry(expiresInSec: number): void {
    this.expiryTimeoutId = window.setTimeout(() => {
      if (this.phase() === 'waiting') {
        this.clearTimers();
        this.deviceCode.set(null);
        this.phase.set('error');
        this.errorMsg.set('Code expired. Please try signing in again.');
      }
    }, expiresInSec * 1000);
  }

  private clearTimers(): void {
    if (this.pollTimeoutId !== null) {
      clearTimeout(this.pollTimeoutId);
      this.pollTimeoutId = null;
    }
    if (this.expiryTimeoutId !== null) {
      clearTimeout(this.expiryTimeoutId);
      this.expiryTimeoutId = null;
    }
  }

  private formatError(err: unknown): string {
    const msg = typeof err === 'string' ? err : (err as Error)?.message ?? 'Sign-in failed';
    if (msg.includes('Client ID is not configured')) {
      return 'GitHub OAuth Client ID is not set. Update src-tauri/src/commands.rs.';
    }
    if (msg.includes('Network')) {
      return 'Network error. Check your internet connection.';
    }
    return msg.length > 200 ? msg.slice(0, 200) + '…' : msg;
  }
}
