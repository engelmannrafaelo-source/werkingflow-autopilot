import { useState } from 'react';

interface PlanChangeModalProps {
  tenantId: string;
  tenantName: string;
  currentPlanId: string;
  onClose: () => void;
  onSuccess: () => void;
}

interface PlanInfo {
  id: string;
  name: string;
  price: number;
  apiCredits: number;
  features: string[];
  limits: {
    dokumenttypen: number | null;
    projekte: number | null;
    dokumenteProProjekt: number | null;
  };
}

const PLANS: Record<string, PlanInfo> = {
  trial: {
    id: 'trial',
    name: 'Trial',
    price: 0,
    apiCredits: 5,
    features: ['14-day trial', 'Basic features', 'Haiku 4.5 only'],
    limits: { dokumenttypen: 1, projekte: 2, dokumenteProProjekt: 3 },
  },
  starter: {
    id: 'starter',
    name: 'Starter',
    price: 40,
    apiCredits: 10,
    features: ['Haiku 4.5', '3 Dokumenttypen', '5 Projekte'],
    limits: { dokumenttypen: 3, projekte: 5, dokumenteProProjekt: 5 },
  },
  professional: {
    id: 'professional',
    name: 'Professional',
    price: 100,
    apiCredits: 35,
    features: ['Sonnet 4.5', '10 Dokumenttypen', '25 Projekte'],
    limits: { dokumenttypen: 10, projekte: 25, dokumenteProProjekt: 20 },
  },
  expert: {
    id: 'expert',
    name: 'Expert',
    price: 250,
    apiCredits: 100,
    features: ['Opus 4.6', 'Unlimited resources', 'Priority support'],
    limits: { dokumenttypen: null, projekte: null, dokumenteProProjekt: null },
  },
  team: {
    id: 'team',
    name: 'Team',
    price: 600,
    apiCredits: 200,
    features: ['Opus 4.6', 'Unlimited resources', '10 seats', 'Team collaboration'],
    limits: { dokumenttypen: null, projekte: null, dokumenteProProjekt: null },
  },
};

export default function PlanChangeModal({
  tenantId,
  tenantName,
  currentPlanId,
  onClose,
  onSuccess,
}: PlanChangeModalProps) {
  const [selectedPlanId, setSelectedPlanId] = useState(currentPlanId);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const currentPlan = PLANS[currentPlanId] || PLANS.starter;
  const selectedPlan = PLANS[selectedPlanId] || PLANS.starter;

  const handleConfirm = async () => {
    if (selectedPlanId === currentPlanId) {
      onClose();
      return;
    }

    setLoading(true);
    setError('');

    try {
      const res = await fetch(`/api/admin/wr/tenants/${tenantId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId: selectedPlanId }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || 'Failed to update plan');
      }

      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const overlayStyle: React.CSSProperties = {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,0.7)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  };

  const modalStyle: React.CSSProperties = {
    background: 'var(--tn-bg)',
    border: '1px solid var(--tn-border)',
    borderRadius: 8,
    width: 700,
    maxWidth: '90vw',
    maxHeight: '90vh',
    overflow: 'auto',
    boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
  };

  const headerStyle: React.CSSProperties = {
    padding: '16px 20px',
    borderBottom: '1px solid var(--tn-border)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  };

  const bodyStyle: React.CSSProperties = {
    padding: 20,
  };

  const footerStyle: React.CSSProperties = {
    padding: '12px 20px',
    borderTop: '1px solid var(--tn-border)',
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 8,
  };

  const planCardStyle = (planId: string): React.CSSProperties => {
    const isCurrent = planId === currentPlanId;
    const isSelected = planId === selectedPlanId;
    return {
      border: isSelected
        ? '2px solid var(--tn-green)'
        : isCurrent
        ? '2px solid var(--tn-blue)'
        : '1px solid var(--tn-border)',
      borderRadius: 6,
      padding: 16,
      cursor: 'pointer',
      background: isSelected ? 'rgba(158,206,106,0.05)' : 'var(--tn-bg-dark)',
      transition: 'all 0.15s',
    };
  };

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <div>
            <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: 'var(--tn-text)' }}>
              Change Plan
            </h3>
            <p style={{ margin: '4px 0 0 0', fontSize: 12, color: 'var(--tn-text-muted)' }}>
              {tenantName}
            </p>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--tn-text-muted)',
              fontSize: 20,
              cursor: 'pointer',
              padding: 4,
            }}
          >
            ×
          </button>
        </div>

        <div style={bodyStyle}>
          {error && (
            <div
              style={{
                padding: '8px 12px',
                fontSize: 12,
                color: 'var(--tn-red)',
                background: 'rgba(247,118,142,0.1)',
                borderRadius: 4,
                marginBottom: 16,
              }}
            >
              {error}
            </div>
          )}

          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, color: 'var(--tn-text-muted)', marginBottom: 8 }}>
              Current Plan: <strong style={{ color: 'var(--tn-blue)' }}>{currentPlan.name}</strong> (
              {currentPlan.price} EUR/month)
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
            {Object.values(PLANS).map((plan) => (
              <div
                key={plan.id}
                style={planCardStyle(plan.id)}
                onClick={() => setSelectedPlanId(plan.id)}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 8,
                  }}
                >
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--tn-text)' }}>
                    {plan.name}
                  </div>
                  {plan.id === currentPlanId && (
                    <span
                      style={{
                        fontSize: 9,
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        padding: '2px 6px',
                        borderRadius: 3,
                        background: 'rgba(125,207,255,0.2)',
                        color: 'var(--tn-blue)',
                      }}
                    >
                      Current
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--tn-green)', marginBottom: 8 }}>
                  {plan.price === 0 ? 'Free' : `€${plan.price}`}
                  <span style={{ fontSize: 11, fontWeight: 400, color: 'var(--tn-text-muted)' }}>
                    /month
                  </span>
                </div>
                <div style={{ fontSize: 11, color: 'var(--tn-text-muted)', marginBottom: 8 }}>
                  {plan.apiCredits} EUR API Credits
                </div>
                <ul style={{ margin: 0, paddingLeft: 20, fontSize: 11, color: 'var(--tn-text)' }}>
                  {plan.features.map((feature, idx) => (
                    <li key={idx} style={{ marginBottom: 4 }}>
                      {feature}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          {selectedPlanId !== currentPlanId && (
            <div
              style={{
                padding: 12,
                background: 'rgba(125,207,255,0.1)',
                border: '1px solid rgba(125,207,255,0.3)',
                borderRadius: 6,
                fontSize: 12,
                color: 'var(--tn-text)',
              }}
            >
              <strong>Plan Change Preview:</strong>
              <div style={{ marginTop: 8, display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 12 }}>
                <div>
                  <div style={{ color: 'var(--tn-text-muted)', fontSize: 10 }}>Current</div>
                  <div style={{ fontWeight: 600 }}>{currentPlan.name}</div>
                  <div style={{ fontSize: 11, marginTop: 4 }}>€{currentPlan.price}/month</div>
                </div>
                <div style={{ alignSelf: 'center', color: 'var(--tn-green)', fontSize: 16 }}>→</div>
                <div>
                  <div style={{ color: 'var(--tn-text-muted)', fontSize: 10 }}>New</div>
                  <div style={{ fontWeight: 600 }}>{selectedPlan.name}</div>
                  <div style={{ fontSize: 11, marginTop: 4 }}>€{selectedPlan.price}/month</div>
                </div>
              </div>
            </div>
          )}
        </div>

        <div style={footerStyle}>
          <button
            onClick={onClose}
            disabled={loading}
            style={{
              padding: '6px 16px',
              borderRadius: 4,
              fontSize: 12,
              fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer',
              background: 'var(--tn-bg)',
              border: '1px solid var(--tn-border)',
              color: 'var(--tn-text)',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleConfirm}
            disabled={loading || selectedPlanId === currentPlanId}
            style={{
              padding: '6px 16px',
              borderRadius: 4,
              fontSize: 12,
              fontWeight: 600,
              cursor: loading || selectedPlanId === currentPlanId ? 'not-allowed' : 'pointer',
              background: 'var(--tn-green)',
              border: 'none',
              color: '#fff',
              opacity: loading || selectedPlanId === currentPlanId ? 0.5 : 1,
            }}
          >
            {loading ? 'Updating...' : 'Confirm Change'}
          </button>
        </div>
      </div>
    </div>
  );
}
