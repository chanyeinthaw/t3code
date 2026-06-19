#pragma once

#include "PulseMarkdownTextRunShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using PulseMarkdownTextRunComponentDescriptor = ConcreteComponentDescriptor<PulseMarkdownTextRunShadowNode>;

void PulseMarkdownTextRunSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
