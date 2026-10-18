/**
 * A password / SSO prompt from the store with no security dialog open (the user closed the setup or unlock dialog
 * while it was still working, and the server then asked for authentication). Same fields as inline prompts.
 * testids: security-prompt-dialog, security-prompt-password, security-prompt-password-submit, security-prompt-sso-hint,
 *          security-prompt-sso-done, dialog-close
 */
import { useEffect, useState } from 'react';
import { useSecurityStore } from '@/store';
import { Dialog } from '@/features/navigation';
import { PromptButtons, PromptFields, submitPrompt } from './PromptFields.tsx';

export function PromptDialog() {
  const prompt = useSecurityStore((s) => s.prompt);
  const [value, setValue] = useState('');
  useEffect(() => setValue(''), [prompt]);
  if (!prompt) return null;
  const cancel = (): void => useSecurityStore.getState().answerPrompt(null);
  return (
    <Dialog
      testId="security-prompt-dialog"
      title="Confirm it is you"
      onSubmit={() => submitPrompt(prompt, value)}
      onClose={cancel}
      footer={<PromptButtons prompt={prompt} prefix="security-prompt" value={value} />}
      closeOnBack
      dataAttrs={{ 'data-kind': prompt.kind }}
    >
      <PromptFields prompt={prompt} prefix="security-prompt" value={value} onChange={setValue} />
    </Dialog>
  );
}
