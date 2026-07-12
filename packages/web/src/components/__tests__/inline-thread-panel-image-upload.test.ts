import { describe, expect, it } from 'vitest';
import { createInlineThreadImageFormData } from '@/components/InlineThreadPanel';

describe('InlineThreadPanel image upload payload', () => {
  it('sends selected images through the existing multipart route with thread reply metadata', () => {
    const image = new File(['image bytes'], 'architecture.png', { type: 'image/png' });

    const body = createInlineThreadImageFormData({
      content: '请看这张图',
      threadId: 'thread-branch',
      userId: 'default-user',
      replyTo: 'message-source',
      images: [image],
    });

    expect(body.get('content')).toBe('请看这张图');
    expect(body.get('threadId')).toBe('thread-branch');
    expect(body.get('userId')).toBe('default-user');
    expect(body.get('replyTo')).toBe('message-source');
    expect(body.getAll('images')).toEqual([image]);
  });
});
