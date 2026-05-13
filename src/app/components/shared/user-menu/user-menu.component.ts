import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import {
  Check,
  ExternalLink,
  LogOut,
  LucideAngularModule,
  Monitor,
  Moon,
  Settings,
  Sun,
  User,
} from 'lucide-angular';
import { TauriBridgeService } from '../../../services/api/tauri-bridge.service';
import { AuthStore } from '../../../services/state/auth.store';
import { ThemeMode, ThemeStore } from '../../../services/state/theme.store';

@Component({
  selector: 'app-user-menu',
  standalone: true,
  imports: [LucideAngularModule],
  templateUrl: './user-menu.component.html',
  styleUrl: './user-menu.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UserMenuComponent {
  private auth = inject(AuthStore);
  private tauri = inject(TauriBridgeService);
  private theme = inject(ThemeStore);
  private router = inject(Router);
  private host = inject(ElementRef<HTMLElement>);

  readonly UserIcon = User;
  readonly SettingsIcon = Settings;
  readonly ExternalIcon = ExternalLink;
  readonly LogOutIcon = LogOut;
  readonly SunIcon = Sun;
  readonly MoonIcon = Moon;
  readonly MonitorIcon = Monitor;
  readonly CheckIcon = Check;

  readonly user = this.auth.user;
  readonly isOpen = signal(false);
  readonly themeMode = this.theme.mode;

  setTheme(mode: ThemeMode): void {
    this.theme.setMode(mode);
  }

  readonly initials = computed(() => {
    const u = this.user();
    if (!u) return '';
    const source = u.name || u.login;
    return source
      .split(/\s+/)
      .map((s) => s.charAt(0).toUpperCase())
      .slice(0, 2)
      .join('');
  });

  readonly avatarHasError = signal(false);

  @HostListener('document:click', ['$event'])
  onDocClick(event: MouseEvent): void {
    if (!this.isOpen()) return;
    const target = event.target as Node;
    if (!this.host.nativeElement.contains(target)) {
      this.isOpen.set(false);
    }
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.isOpen()) this.isOpen.set(false);
  }

  toggle(event: MouseEvent): void {
    event.stopPropagation();
    this.isOpen.update((v) => !v);
  }

  onAvatarError(): void {
    this.avatarHasError.set(true);
  }

  async openGithubProfile(): Promise<void> {
    const u = this.user();
    if (!u) return;
    this.isOpen.set(false);
    await this.tauri.openExternal(`https://github.com/${u.login}`);
  }

  openSettings(): void {
    this.isOpen.set(false);
  }

  async signOut(): Promise<void> {
    this.isOpen.set(false);
    this.auth.clear();
    await this.router.navigate(['/login']);
  }
}
