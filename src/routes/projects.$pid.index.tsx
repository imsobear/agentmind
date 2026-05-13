import { createFileRoute } from '@tanstack/react-router'
import { MessageSquare } from 'lucide-react'

export const Route = createFileRoute('/projects/$pid/')({ component: PickAMessage })

function PickAMessage() {
  return (
    <div className="h-full flex items-center justify-center text-muted-foreground">
      <div className="text-center max-w-sm px-6">
        <MessageSquare className="w-10 h-10 mx-auto mb-4 opacity-50" />
        <div className="text-base font-medium text-foreground mb-2">Pick a message</div>
        <p className="text-sm">
          Each entry in the middle pane is one prompt the user typed. Click it
          to see every API/LLM iteration it triggered.
        </p>
      </div>
    </div>
  )
}
