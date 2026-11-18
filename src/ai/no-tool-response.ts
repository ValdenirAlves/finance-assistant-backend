export function financialSafetyFallback(portuguese: boolean) {
  return portuguese
    ? 'Não foi possível verificar os dados financeiros nesta consulta. Pergunte sobre despesas ou informe os detalhes para preparar um rascunho; salvar exige confirmação explícita.'
    : 'No financial data was retrieved. Ask about expenses or provide expense details to prepare a draft; saving requires explicit confirmation.';
}
