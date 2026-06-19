#pragma once

#include <react/renderer/components/PulseMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/PulseMarkdownTextSpec/Props.h>
#include <react/renderer/components/PulseMarkdownTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char PulseMarkdownTextRunComponentName[];

using PulseMarkdownTextRunShadowNode = ConcreteViewShadowNode<
    PulseMarkdownTextRunComponentName,
    PulseMarkdownTextRunProps,
    PulseMarkdownTextRunEventEmitter,
    PulseMarkdownTextRunState>;
}
