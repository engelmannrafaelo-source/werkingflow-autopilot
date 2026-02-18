import { useState, useEffect, useRef, useCallback } from 'react';

const API = '/api';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp?: string;
}

interface PersonaChatProps {
  personaId: string;
  personaName: string;
}

export default function PersonaChat({ personaId, personaName }: PersonaChatProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    loadHistory();
  }, [personaId]);

  useEffect(() => {
    // Auto-scroll to bottom when new messages arrive
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function loadHistory() {
    try {
      const response = await fetch(`${API}/team/chat/${personaId}/history`);
      if (!response.ok) {
        console.warn('[PersonaChat] History not available');
        return;
      }
      const data = await response.json();
      setMessages(data.messages || []);
    } catch (err: any) {
      console.error('[PersonaChat] Load history error:', err);
    }
  }

  async function sendMessage() {
    if (!input.trim() || loading) return;

    const userMessage: Message = { role: 'user', content: input };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setLoading(true);
    setError(null);

    try {
      const response = await fetch(`${API}/team/chat/${personaId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: input }),
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || 'Failed to send message');
      }

      const data = await response.json();
      const assistantMessage: Message = {
        role: 'assistant',
        content: data.message,
        timestamp: new Date().toISOString(),
      };
      setMessages(prev => [...prev, assistantMessage]);
    } catch (err: any) {
      console.error('[PersonaChat] Send error:', err);
      setError(err.message);
      // Remove the user message if sending failed
      setMessages(prev => prev.slice(0, -1));
    } finally {
      setLoading(false);
    }
  }

  function handleKeyPress(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  return (
    <div className="persona-chat">
      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '0.75rem 1rem',
        background: 'var(--tn-bg-dark)',
        borderBottom: '1px solid var(--tn-border)',
      }}>
        <h3 style={{ margin: 0, fontSize: 14, color: 'var(--tn-text)' }}>
          Chat with {personaName}
        </h3>
        <span style={{ fontSize: 11, color: 'var(--tn-text-muted)' }}>
          {messages.length} messages
        </span>
      </div>

      {/* Messages */}
      <div style={{
        flex: 1,
        overflowY: 'auto',
        padding: '1rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
      }}>
        {messages.length === 0 ? (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            height: '100%',
            color: 'var(--tn-text-muted)',
            fontSize: 12,
            textAlign: 'center',
          }}>
            No messages yet. Start chatting with {personaName}!
          </div>
        ) : (
          messages.map((msg, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
              }}
            >
              <div style={{
                fontSize: 10,
                color: 'var(--tn-text-muted)',
                marginBottom: '0.25rem',
              }}>
                {msg.role === 'user' ? 'Rafael' : personaName}
              </div>
              <div style={{
                maxWidth: '70%',
                padding: '0.75rem',
                background: msg.role === 'user' ? 'var(--tn-blue)' : 'var(--tn-surface)',
                color: msg.role === 'user' ? 'white' : 'var(--tn-text)',
                borderRadius: 8,
                fontSize: 12,
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                wordWrap: 'break-word',
              }}>
                {msg.content}
              </div>
            </div>
          ))
        )}

        {loading && (
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            color: 'var(--tn-text-muted)',
            fontSize: 11,
          }}>
            <div className="loading-dots" style={{ display: 'flex', gap: '0.25rem' }}>
              <span style={{ animation: 'pulse 1.5s ease-in-out infinite' }}>●</span>
              <span style={{ animation: 'pulse 1.5s ease-in-out 0.2s infinite' }}>●</span>
              <span style={{ animation: 'pulse 1.5s ease-in-out 0.4s infinite' }}>●</span>
            </div>
            {personaName} is typing...
          </div>
        )}

        {error && (
          <div style={{
            padding: '0.75rem',
            background: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: 6,
            color: 'var(--tn-red)',
            fontSize: 12,
          }}>
            Error: {error}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div style={{
        display: 'flex',
        gap: '0.5rem',
        padding: '1rem',
        background: 'var(--tn-bg-dark)',
        borderTop: '1px solid var(--tn-border)',
      }}>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyPress={handleKeyPress}
          placeholder={`Message ${personaName}... (Shift+Enter for new line)`}
          disabled={loading}
          rows={2}
          style={{
            flex: 1,
            padding: '0.5rem',
            background: 'var(--tn-bg)',
            color: 'var(--tn-text)',
            border: '1px solid var(--tn-border)',
            borderRadius: 6,
            fontSize: 12,
            fontFamily: 'inherit',
            resize: 'none',
            outline: 'none',
          }}
        />
        <button
          onClick={sendMessage}
          disabled={!input.trim() || loading}
          style={{
            padding: '0.5rem 1rem',
            background: loading || !input.trim() ? 'var(--tn-bg)' : 'var(--tn-blue)',
            color: loading || !input.trim() ? 'var(--tn-text-muted)' : 'white',
            border: 'none',
            borderRadius: 6,
            cursor: loading || !input.trim() ? 'not-allowed' : 'pointer',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
