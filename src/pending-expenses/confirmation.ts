// Match the entire message, never a substring or model-provided confidence score.
export function pendingAction(
  message: string,
): 'confirm' | 'cancel' | 'unclear' | null {
  const normalized = message
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[.!?]+$/, '')
    .trim();
  if (
    [
      'yes',
      'yes, save it',
      'yes save it',
      'confirm',
      'save it',
      'go ahead',
      'sim',
      'confirma',
      'confirmar',
      'pode salvar',
    ].includes(normalized)
  )
    return 'confirm';
  if (
    [
      'no',
      'cancel',
      'never mind',
      "don't save it",
      'do not save it',
      'nao',
      'cancela',
      'cancelar',
      'nao salve',
      'nao salvar',
    ].includes(normalized)
  )
    return 'cancel';
  if (
    [
      'maybe',
      'i think so',
      'wait',
      'change it',
      'talvez',
      'acho que sim',
      'espere',
      'aguarde',
    ].includes(normalized)
  )
    return 'unclear';
  return null;
}

export function isPortuguese(message: string) {
  return /\b(sim|confirma|confirmar|pode|salvar|cancela|cancelar|nao|talvez|acho|aguarde|espere)\b/.test(
    message
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, ''),
  );
}
