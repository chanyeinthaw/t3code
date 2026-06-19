#pragma once

#include "PulseMarkdownTextShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using PulseMarkdownTextComponentDescriptor = ConcreteComponentDescriptor<PulseMarkdownTextShadowNode>;

void PulseMarkdownTextSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
