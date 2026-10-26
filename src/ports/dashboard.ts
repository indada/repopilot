import type { DashboardSnapshot } from '../domain/dashboard.js';
export interface DashboardReader { snapshot(): Promise<DashboardSnapshot>; }
