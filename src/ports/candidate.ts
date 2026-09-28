import type { Candidate } from '../domain/candidate.js';

export interface CandidateStore {
  read(id: string): Promise<Candidate | undefined>;
  list(): Promise<Candidate[]>;
  save(candidate: Candidate): Promise<void>;
}
