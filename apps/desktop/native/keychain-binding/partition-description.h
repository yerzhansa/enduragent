#pragma once

#include <CoreFoundation/CoreFoundation.h>
#include <Security/SecACL.h>

enum class KeychainAclRole { kOwner, kPartition, kUnrelated, kUnsafe };

struct KeychainAccessAclInspection {
  CFIndex ownerCount;
  CFIndex partitionCount;
  bool exact;
};

bool IsExpectedPartitionDescription(CFStringRef description);
bool AreExpectedPartitionDescriptions(CFArrayRef descriptions);
bool IsExpectedPartitionAcl(CFArrayRef authorizations, CFArrayRef applications,
                            CFStringRef description,
                            SecKeychainPromptSelector prompt);
KeychainAclRole ClassifyKeychainAcl(CFArrayRef authorizations);
bool IsExpectedOwnerAcl(CFArrayRef authorizations, CFArrayRef applications);
void IncludeKeychainAcl(KeychainAccessAclInspection &inspection,
                        KeychainAclRole role, CFArrayRef authorizations,
                        CFArrayRef applications, CFStringRef description,
                        SecKeychainPromptSelector prompt);
bool IsExpectedKeychainAccess(
    const KeychainAccessAclInspection &inspection);
