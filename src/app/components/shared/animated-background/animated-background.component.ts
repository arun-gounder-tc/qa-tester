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

  private readonly PARTICLE_COUNT = 60;
  private readonly LINK_DISTANCE = 130;
  private readonly PARTICLE_COLOR = 'rgba(99, 102, 241, 0.55)';
  private readonly LINK_COLOR_RGB = '99, 102, 241';

  ngAfterViewInit(): void {
    if (this.prefersReducedMotion()) return;
    const canvas = this.canvasRef.nativeElement;
    this.ctx = canvas.getContext('2d');
    if (!this.ctx) return;
    this.resize();
    this.seed();
    this.tick();
  }

  ngOnDestroy(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
    }
  }

  @HostListener('window:resize')
  onResize(): void {
    this.resize();
    this.seed();
  }

  private prefersReducedMotion(): boolean {
    return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  }

  private resize(): void {
    const canvas = this.canvasRef.nativeElement;
    const rect = this.host.nativeElement.getBoundingClientRect();
    canvas.width = rect.width * this.dpr;
    canvas.height = rect.height * this.dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    this.ctx?.scale(this.dpr, this.dpr);
  }

  private seed(): void {
    const canvas = this.canvasRef.nativeElement;
    const width = canvas.width / this.dpr;
    const height = canvas.height / this.dpr;
    this.particles = Array.from({ length: this.PARTICLE_COUNT }, () => ({
      x: Math.random() * width,
      y: Math.random() * height,
      vx: (Math.random() - 0.5) * 0.25,
      vy: (Math.random() - 0.5) * 0.25,
      radius: Math.random() * 1.4 + 0.6,
    }));
  }

  private tick = (): void => {
    if (!this.ctx) return;
    const canvas = this.canvasRef.nativeElement;
    const width = canvas.width / this.dpr;
    const height = canvas.height / this.dpr;

    this.ctx.clearRect(0, 0, width, height);

    for (const p of this.particles) {
      p.x += p.vx;
      p.y += p.vy;

      if (p.x < 0 || p.x > width) p.vx *= -1;
      if (p.y < 0 || p.y > height) p.vy *= -1;

      this.ctx.beginPath();
      this.ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2);
      this.ctx.fillStyle = this.PARTICLE_COLOR;
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
          this.ctx.strokeStyle = `rgba(${this.LINK_COLOR_RGB}, ${opacity})`;
          this.ctx.lineWidth = 0.6;
          this.ctx.stroke();
        }
      }
    }

    this.animationId = requestAnimationFrame(this.tick);
  };
}
