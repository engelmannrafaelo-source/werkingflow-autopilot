import ErrorBoundary from '../../../ErrorBoundary';
import CCUsageTab from './CCUsageTab';

// AccountsTab wraps CCUsageTab (Claude Code account management) as-is.
// Tenant usage and pricing reference were moved to DashboardTab.
export default function AccountsTab() {
  return (
    <ErrorBoundary componentName="CCUsageTab">
      <CCUsageTab />
    </ErrorBoundary>
  );
}
