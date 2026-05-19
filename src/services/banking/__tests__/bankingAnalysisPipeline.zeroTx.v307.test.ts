// BF_SERVER_BLOCK_v307_BANKING_ZERO_TX_GUARD_v1
import { describe, it, expect } from "vitest";

describe("Banking pipeline zero-tx guard", () => {
  it.todo("writes status='failed' with last_error when 0 transactions extracted");
  it.todo("does not touch applications.banking_completed_at on zero-tx");
  it.todo("still writes 'analysis_complete' when transactions > 0");
});
