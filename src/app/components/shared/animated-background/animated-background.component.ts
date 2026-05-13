import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  HostListener,
  OnDestroy,
  ViewChild,
  inject,
} from '@angular/core';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
}

@Component({
  selector: 'app-animated-background',
  standalone: true,
  imports: [],
  templateUrl: './animated-background.component.html',
  styleUrl: './animated-background.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AnimatedBackgroundComponent implements AfterViewInit, OnDestroy {
  private host = inject(ElementRef<HTMLElement>);

  @ViewChild('canvas', { static: true }) canvasRef!: ElementRef<HTMLCanvasElement>;

  private ctx: CanvasRenderingContext2D | null = null;
  private animationId: number | null = null;
  private particles: Particle[] = [];
  private dpr = window.devicePixelRatio || 1;
  private resizeObserver: ResizeObserver | null = null;
  private lastSeededSize = { w: 0, h: 0 };

  private readonly PARTICLE_COUNT = 60;
  private readonly LINK_DISTANCE = 130;

  ngAfterViewInit(): void {
    if (this.prefersReducedMotion()) return;
    const canvas = this.canvasRef.nativeElement;
    this.ctx = canvas.getContext('2d');
    if (!this.ctx) return;
    this.resize();
    this.seed();
    this.tick();

    // The host may grow after fonts/layout settle. Re-size + re-seed
    // whenever its real bounding box changes meaningfully.
    if ('ResizeObserver' in window) {
      this.resizeObserver = new ResizeObserver(() => this.handleHostResize());
      this.resizeObserver.observe(this.host.nativeElement);
    }
  }

  ngOnDestroy(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
  }

  @HostListener('window:resize')
  onResize(): void {
    this.handleHostResize();
  }

  private handleHostResize(): void {
    const rect = this.host.nativeElement.getBoundingClientRect();
    // Skip noise — only re-seed if size meaningfully changed.
    if (
      Math.abs(rect.width - this.lastSeededSize.w) < 20 &&
      Math.abs(rect.height - this.lastSeededSize.h) < 20
    ) {
      this.resize();
      return;
    }
    this.resize();
    this.seed();
  }

  private prefersReducedMotion(): boolean {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }

  private resize(): void {
    const canvas = this.canvasRef.nativeElement;
    const rect = this.host.nativeElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    canvas.width = rect.width * this.dpr;
    canvas.height = rect.height * this.dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    // Setting canvas.width resets the context transform, so reapply DPR.
    this.ctx?.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private seed(): void {
    const canvas = this.canvasRef.nativeElement;
    const width = canvas.width / this.dpr;
    const height = canvas.height / this.dpr;
    if (width <= 0 || height <= 0) return;
    // Scale particle count with viewport area so big screens look populated.
    const area = width * height;
    const count = Math.min(
      140,
      Math.max(this.PARTICLE_COUNT, Math.round(area / 14000)),
    );
    this.particles = Array.from({ length: count }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.25,
      vy: (Math.random() - 0.5) * 0.25,
      radius: Math.random() * 1.4 + 0.6,
    }));
    this.lastSeededSize = { w: width, h: height };
  }

  private brandRgb = '99 102 241';

  private refreshBrandColor(): void {
    const value = getComputedStyle(document.documentElement)
      .getPropertyValue('--color-brand')
      .trim();
    if (value) this.brandRgb = value;
  }

  private tick = (): void => {
    if (!this.ctx) return;
    // Re-read brand color once per frame so theme switches take effect live.
    this.refreshBrandColor();
    const canvas = this.canvasRef.nativeElement;
    const width = canvas.width / this.dpr;
    const height = canvas.height / this.dpr;

    this.ctx.clearRect(0, 0, width, height);

    const particleColor = `rgb(${this.brandRgb} / 0.55)`;

    for (const p of this.particles) {
      p.x += p.vx;
      p.y += p.vy;

      if (p.x < 0 || p.x > width) p.vx *= -1;
      if (p.y < 0 || p.y > height) p.vy *= -1;

      this.ctx.beginPath();
      this.ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      this.ctx.fillStyle = particleColor;
      this.ctx.fill();
    }

    for (let i = 0; i < this.particles.length; i++) {
      for (let j = i + 1; j < this.particles.length; j++) {
        const a = this.particles[i];
        const b = this.particles[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < this.LINK_DISTANCE) {
          const opacity = (1 - dist / this.LINK_DISTANCE) * 0.25;
          this.ctx.beginPath();
          this.ctx.moveTo(a.x, a.y);
          this.ctx.lineTo(b.x, b.y);
          this.ctx.strokeStyle = `rgb(${this.brandRgb} / ${opacity})`;
          this.ctx.lineWidth = 0.6;
          this.ctx.stroke();
        }
      }
    }

    this.animationId = requestAnimationFrame(this.tick);
  };
}
