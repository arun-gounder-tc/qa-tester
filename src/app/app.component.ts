import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { ToastComponent } from './components/shared/toast/toast.component';
import { ThemeStore } from './services/state/theme.store';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, ToastComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  // Boot the theme store immediately so the `.dark` class is on <html>
  // before the first route (including /login) renders.
  private theme = inject(ThemeStore);
}
