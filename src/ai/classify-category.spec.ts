import { classifyCategory } from './classify-category.js';
import type OpenAI from 'openai';
describe('structured category fallback', () => {
  const create = vi.fn();
  const client = { responses: { create } } as unknown as OpenAI;
  beforeEach(() => create.mockReset());
  it('accepts allowed structured category for unknown merchant', async () => {
    create.mockResolvedValue({
      status: 'completed',
      output_text: '{"category":"GROCERIES"}',
    });
    expect(await classifyCategory(client, 'gpt-6-luna', 'SuperValu')).toBe(
      'GROCERIES',
    );
    expect(
      create.mock.calls[0][0].text.format.schema.properties.category.enum,
    ).toContain('OTHER');
    expect(create.mock.calls[0][0]).toMatchObject({
      model: 'gpt-6-luna',
      text: { format: { type: 'json_schema', strict: true } },
    });
  });
  it('rejects arbitrary category', async () => {
    create.mockResolvedValue({
      status: 'completed',
      output_text: '{"category":"BANKING"}',
    });
    await expect(
      classifyCategory(client, 'gpt-6-luna', 'unknown'),
    ).rejects.toThrow('Invalid classification category');
  });
  it('uses OTHER when uncertain or provider unavailable', async () => {
    create.mockResolvedValueOnce({
      status: 'completed',
      output_text: '{"category":"OTHER"}',
    });
    expect(await classifyCategory(client, 'gpt-6-luna', 'unknown')).toBe(
      'OTHER',
    );
    create.mockRejectedValueOnce(new Error('unavailable'));
    expect(await classifyCategory(client, 'gpt-6-luna', 'unknown')).toBe(
      'OTHER',
    );
  });
});
