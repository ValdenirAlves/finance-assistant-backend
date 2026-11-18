import { financialSafetyFallback } from './no-tool-response.js';
describe('financial safety fallback', () => {
  it('localizes the safety fallback instead of hardcoding Portuguese for all requests', () => {
    expect(financialSafetyFallback(true)).toContain(
      'Não foi possível verificar',
    );
    expect(financialSafetyFallback(false)).toContain('No financial data');
  });
});
