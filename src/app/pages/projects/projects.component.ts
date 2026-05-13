import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import {
  AlertTriangle,
  ChevronRight,
  FolderGit2,
  LucideAngularModule,
  Plus,
  RefreshCw,
  TestTube2,
  Trash2,
} from 'lucide-angular';
import { ButtonComponent } from '../../components/shared/button/button.component';
import {
  ConfirmationConfig,
  ConfirmationModalComponent,
} from '../../components/shared/confirmation-modal/confirmation-modal.component';
import { PathBreadcrumbsComponent } from '../../components/shared/path-breadcrumbs/path-breadcrumbs.component';
import { UserMenuComponent } from '../../components/shared/user-menu/user-menu.component';
import { CloneProjectModalComponent } from './clone-project-modal/clone-project-modal.component';
import { Project } from '../../models/project.model';
import { ProjectsStore } from '../../services/state/projects.store';
import { NotificationService } from '../../services/utils/notification.service';

@Component({
  selector: 'app-projects',
  standalone: true,
  imports: [
    ButtonComponent,
    LucideAngularModule,
    CloneProjectModalComponent,
    UserMenuComponent,
    ConfirmationModalComponent,
    PathBreadcrumbsComponent,
  ],
  templateUrl: './projects.component.html',
  styleUrl: './projects.component.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProjectsComponent implements OnInit {
  private projects = inject(ProjectsStore);
  private notify = inject(NotificationService);
  private router = inject(Router);

  readonly LogoIcon = TestTube2;
  readonly PlusIcon = Plus;
  readonly FolderIcon = FolderGit2;
  readonly ChevronIcon = ChevronRight;
  readonly WarnIcon = AlertTriangle;
  readonly TrashIcon = Trash2;
  readonly RefreshIcon = RefreshCw;

  readonly projectList = this.projects.projects;
  readonly hasProjects = this.projects.hasProjects;

  readonly isCloneModalOpen = signal(false);
  readonly removeTarget = signal<Project | null>(null);

  readonly removeConfig = signal<ConfirmationConfig>({
    title: 'Remove project?',
    message: '',
    confirmText: 'Remove',
    cancelText: 'Cancel',
    variant: 'destructive',
  });

  ngOnInit(): void {
    void this.projects.refreshAllStatus();
  }

  openCloneModal(): void {
    this.isCloneModalOpen.set(true);
  }

  closeCloneModal(): void {
    this.isCloneModalOpen.set(false);
  }

  onProjectCloned(project: Project): void {
    this.projects.addProject(project);
    this.isCloneModalOpen.set(false);
    this.notify.success(`${project.name} added`);
  }

  openProject(project: Project): void {
    if (project.status === 'missing') {
      this.askRemove(project);
      return;
    }
    this.projects.selectProject(project.id);
    void this.router.navigate(['/projects', project.id]);
  }

  askRemove(project: Project, event?: Event): void {
    event?.stopPropagation();
    this.removeTarget.set(project);
    this.removeConfig.set({
      title: project.status === 'missing' ? 'Project folder not found' : 'Remove project?',
      message:
        project.status === 'missing'
          ? `The local folder for ${project.name} no longer exists. Remove it from the list?`
          : `${project.name} will be removed from the app. Local files are not deleted.`,
      details:
        project.status === 'missing'
          ? [project.localPath]
          : undefined,
      confirmText: 'Remove',
      cancelText: 'Cancel',
      variant: 'destructive',
    });
  }

  confirmRemove(): void {
    const target = this.removeTarget();
    if (target) {
      this.projects.removeProject(target.id);
      this.notify.success(`${target.name} removed from list`);
    }
    this.removeTarget.set(null);
  }

  cancelRemove(): void {
    this.removeTarget.set(null);
  }

  refreshStatuses(): void {
    void this.projects.refreshAllStatus();
  }
}
