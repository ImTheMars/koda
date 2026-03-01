/**
 * Benchmark suite types — all interfaces for test cases, results, grading, and reports.
 */

export interface TestCase {
  id: string;
  category: string;
  name: string;
  description: string;
  turns: TurnInput[];
  grading: GradingCriteria;
  setup?: SetupAction[];
  teardown?: TeardownAction[];
}

export interface TurnInput {
  /** Static user message — used as-is. */
  message?: string;
  /** Scenario description — fed to LLM simulator to generate a realistic user message. */
  simulate?: string;
  /** Expected tier for this turn. */
  expectedTier?: "fast" | "deep";
}

export interface GradingCriteria {
  requiredTools?: string[];
  forbiddenTools?: string[];
  expectedTier?: "fast" | "deep";
  mustContain?: string[];
  mustNotContain?: string[];
  /** Free-form prompt for the LLM judge. */
  judgePrompt?: string;
  /** Custom programmatic assertion — return null for pass, string for failure reason. */
  assert?: (turns: TurnResult[]) => string | null;
}

export interface SetupAction {
  type: "storeMemory" | "writeFile" | "createTask";
  data: Record<string, string>;
}

export interface TeardownAction {
  type: "deleteFile" | "deleteTask" | "clearMemory";
  data: Record<string, string>;
}

export interface TurnResult {
  input: string;
  output: string;
  tier: "fast" | "deep";
  toolsUsed: string[];
  usage: { promptTokens: number; completionTokens: number; cost: number };
  wallClockMs: number;
  error?: string;
}

export interface GradeScores {
  correctness: number;
  toolUsage: number;
  responseQuality: number;
  tone: number;
  overall: number;
  judgeReasoning: string;
}

export interface TestResult {
  testId: string;
  category: string;
  name: string;
  turns: TurnResult[];
  scores: GradeScores;
  totalCost: number;
  totalWallClockMs: number;
  passed: boolean;
}

export interface CategorySummary {
  category: string;
  testsRun: number;
  testsPassed: number;
  avgScore: number;
  avgWallClockMs: number;
  totalCost: number;
}

export interface BenchReport {
  id: string;
  timestamp: string;
  modelConfig: {
    deepModel: string;
    fastModel: string;
    judgeModel: string;
  };
  categories: CategorySummary[];
  results: TestResult[];
  totals: {
    testsRun: number;
    passed: number;
    overallScore: number;
    totalCost: number;
    judgeCost: number;
    totalWallClockMs: number;
  };
}

export interface BenchOptions {
  model?: string;
  fastModel?: string;
  category?: string;
  verbose: boolean;
  compare?: string;
  skipComposio: boolean;
  judgeModel: string;
  output?: string;
  help: boolean;
}
